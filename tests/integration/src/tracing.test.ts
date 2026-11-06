import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startHarness, type Harness } from './harness.js';

// The trace context crosses the outbox and the queue by hand, which is what
// this checks. The HTTP, pg and undici spans come from instrumentations
// loaded only in production, so a test span stands in for the API request.
describe('tracing', () => {
  const exporter = new InMemorySpanExporter();
  let h: Harness;

  function spanNamed(name: string, traceId: string): ReadableSpan {
    const span = exporter
      .getFinishedSpans()
      .find(
        (item) => item.name === name && item.spanContext().traceId === traceId,
      );
    if (!span) {
      throw new Error(`No span ${name} in trace ${traceId}`);
    }
    return span;
  }

  function consumeSpans(deliveryId: string): ReadableSpan[] {
    return exporter
      .getFinishedSpans()
      .filter(
        (item) =>
          item.name === 'process deliveries.ready' &&
          item.attributes['hookline.delivery.id'] === deliveryId,
      );
  }

  beforeAll(async () => {
    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    );
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.setGlobalTracerProvider(
      new TracerProvider({
        spanProcessors: [new SimpleSpanProcessor({ exporter })],
      }),
    );
    h = await startHarness('1s,1s,1s,1s,1s');
  });

  afterAll(async () => {
    await h?.stop();
    trace.disable();
    propagation.disable();
    context.disable();
  });

  it('follows an event from the API to its delivery, and links the retry', async () => {
    await h.createEndpoint(['trace.test']);
    // The first attempt fails, and the second, a second later, succeeds.
    h.receiver.configure({ status: 200, fail_next: 1 });

    const tracer = trace.getTracer('test');
    const { request, event } = await tracer.startActiveSpan(
      'POST /v1/events',
      async (span) => {
        const published = await h.publish('trace.test');
        span.end();
        return { request: span.spanContext(), event: published };
      },
    );
    const delivery = await h.waitForDelivery(event.id, 'succeeded');

    const attempts = await vi.waitFor(() => {
      const spans = consumeSpans(delivery.id);
      expect(spans).toHaveLength(2);
      return spans.sort(
        (a, b) =>
          Number(a.attributes['hookline.delivery.attempt']) -
          Number(b.attributes['hookline.delivery.attempt']),
      );
    });
    const [first, second] = attempts as [ReadableSpan, ReadableSpan];

    // API request -> relay publish -> first attempt, one trace.
    const publishReady = spanNamed('publish delivery.ready', request.traceId);
    expect(publishReady.parentSpanContext?.spanId).toBe(request.spanId);
    expect(first.spanContext().traceId).toBe(request.traceId);
    expect(first.parentSpanContext?.spanId).toBe(
      publishReady.spanContext().spanId,
    );
    expect(first.attributes['hookline.outcome']).toBe('retry');

    // The retry's row was written inside the first attempt.
    const publishWait = spanNamed('publish delivery.wait.1s', request.traceId);
    expect(publishWait.parentSpanContext?.spanId).toBe(
      first.spanContext().spanId,
    );

    // The second attempt is a trace of its own, linked to the first one's.
    expect(second.spanContext().traceId).not.toBe(request.traceId);
    expect(second.parentSpanContext).toBeUndefined();
    expect(second.links.map((link) => link.context.spanId)).toEqual([
      publishWait.spanContext().spanId,
    ]);
    expect(second.attributes['hookline.outcome']).toBe('succeeded');
  });

  it('stores nothing when there is no trace', async () => {
    await h.createEndpoint(['trace.none']);
    h.receiver.configure({ status: 200, fail_next: 0 });

    const event = await h.publish('trace.none');
    await h.waitForDelivery(event.id, 'succeeded');

    const { rows } = await h.pool.query<{ trace_context: unknown }>(
      `SELECT o.trace_context FROM outbox o
       JOIN deliveries d ON d.id = o.delivery_id
       WHERE d.event_id = $1`,
      [event.id],
    );
    expect(rows).toEqual([{ trace_context: null }]);
  });
});
