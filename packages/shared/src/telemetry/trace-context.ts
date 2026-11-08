import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Link,
} from '@opentelemetry/api';

// A trace crosses the outbox and the queue by hand: the code that writes an
// outbox row stores the W3C trace context of that moment, the relay
// publishes as a child of it and puts its own context in the message
// headers, and the delivery worker continues from those headers. Without
// tracing started, every function here is a no-op.

// The W3C traceparent and tracestate headers, as stored and sent.
export type TraceCarrier = Record<string, string>;

const tracer = trace.getTracer('hookline');

// The active trace context, for an outbox row; null when nothing is traced.
export function captureTraceContext(): TraceCarrier | null {
  const carrier: TraceCarrier = {};
  propagation.inject(context.active(), carrier);
  return Object.keys(carrier).length > 0 ? carrier : null;
}

function toCarrier(headers: Record<string, unknown> | undefined) {
  const carrier: TraceCarrier = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (typeof value === 'string') {
      carrier[key] = value;
    }
  }
  return carrier;
}

async function inSpan<T>(
  name: string,
  kind: SpanKind,
  parent: Context,
  options: { attributes?: Attributes; links?: Link[] },
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    name,
    { kind, ...options },
    parent,
    async (span) => {
      try {
        return await fn();
      } catch (error) {
        markSpanFailed(error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

// Runs a publish as a child of the context stored with its outbox row, and
// hands over the headers that carry this span to the consumer.
export function withPublishSpan<T>(
  name: string,
  stored: TraceCarrier | null,
  attributes: Attributes,
  publish: (headers: TraceCarrier) => Promise<T>,
): Promise<T> {
  const parent = stored
    ? propagation.extract(ROOT_CONTEXT, stored)
    : ROOT_CONTEXT;
  return inSpan(name, SpanKind.PRODUCER, parent, { attributes }, () => {
    const headers: TraceCarrier = {};
    propagation.inject(context.active(), headers);
    return publish(headers);
  });
}

// Runs the processing of a message in the trace its headers carry. With
// `link`, it starts a new trace that links to that one instead: a retry
// can come hours later, and one trace per attempt stays short enough to
// search and read.
export function withConsumeSpan<T>(
  name: string,
  headers: Record<string, unknown> | undefined,
  { link, attributes }: { link: boolean; attributes: Attributes },
  consume: () => Promise<T>,
): Promise<T> {
  const remote = propagation.extract(ROOT_CONTEXT, toCarrier(headers));
  const remoteSpan = trace.getSpanContext(remote);
  if (!link) {
    return inSpan(name, SpanKind.CONSUMER, remote, { attributes }, consume);
  }
  return inSpan(
    name,
    SpanKind.CONSUMER,
    ROOT_CONTEXT,
    { attributes, links: remoteSpan ? [{ context: remoteSpan }] : [] },
    consume,
  );
}

export function setSpanAttributes(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}

// Names the HTTP server span after the route, such as POST /v1/events, so
// traces can be searched by route instead of by raw URL.
export function nameServerSpan(method: string, route: string): void {
  trace
    .getActiveSpan()
    ?.updateName(`${method} ${route}`)
    .setAttribute('http.route', route);
}

export function markSpanFailed(error: unknown): void {
  const span = trace.getActiveSpan();
  if (!span) {
    return;
  }
  if (error instanceof Error) {
    span.recordException(error);
  }
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : String(error),
  });
}

// The tracing module, loaded before the app, registers how to flush its
// spans; the shutdown handler calls it last. A global, because that module
// is loaded on its own and must not import the rest of this package.
const SHUTDOWN = Symbol.for('hookline.tracing.shutdown');

type TracingGlobal = { [SHUTDOWN]?: () => Promise<void> };

export function setTracingShutdown(shutdown: () => Promise<void>): void {
  (globalThis as TracingGlobal)[SHUTDOWN] = shutdown;
}

export async function shutdownTracing(): Promise<void> {
  await (globalThis as TracingGlobal)[SHUTDOWN]?.();
}
