import type { Registry } from '@hookline/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startHarness, type Harness } from './harness.js';

describe('metrics', () => {
  let h: Harness;

  // The value of one series, or 0 when it has not been recorded yet.
  async function value(
    registry: Registry,
    name: string,
    labels: Record<string, string> = {},
  ): Promise<number> {
    // A histogram is registered without the _count and _sum suffixes.
    const metric =
      registry.getSingleMetric(name) ??
      registry.getSingleMetric(name.replace(/_(count|sum)$/, ''));
    if (!metric) {
      throw new Error(`No metric named ${name}`);
    }
    const { values } = await metric.get();
    // Histograms list their buckets, sum and count under one metric, each
    // value named with its suffix.
    const match = (
      values as {
        metricName?: string;
        labels: Record<string, unknown>;
        value: number;
      }[]
    ).find(
      (item) =>
        (item.metricName === undefined || item.metricName === name) &&
        Object.entries(labels).every(
          ([key, expected]) => item.labels[key] === expected,
        ),
    );
    return match?.value ?? 0;
  }

  beforeAll(async () => {
    h = await startHarness('1s,1s,1s,1s,1s');
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('counts an event from the API to a retried delivery', async () => {
    const { api, relay, worker } = h.registries;
    await h.createEndpoint(['metrics.test']);
    // The first attempt fails and the second, a second later, succeeds.
    h.receiver.configure({ status: 200, fail_next: 1 });

    const event = await h.publish('metrics.test');
    await h.waitForDelivery(event.id, 'succeeded');

    expect(await value(api, 'hookline_events_accepted_total')).toBe(1);
    expect(await value(api, 'hookline_deliveries_created_total')).toBe(1);
    expect(
      await value(api, 'hookline_http_request_duration_seconds_count', {
        method: 'POST',
        route: '/v1/events',
        status_class: '2xx',
      }),
    ).toBe(1);

    expect(
      await value(worker, 'hookline_delivery_attempts_total', {
        outcome: 'retry',
      }),
    ).toBe(1);
    expect(
      await value(worker, 'hookline_delivery_attempts_total', {
        outcome: 'succeeded',
      }),
    ).toBe(1);
    // Only the first attempt measures the delay since the event.
    expect(
      await value(
        worker,
        'hookline_delivery_first_attempt_delay_seconds_count',
      ),
    ).toBe(1);

    expect(
      await value(relay, 'hookline_outbox_published_total', { kind: 'ready' }),
    ).toBe(1);
    expect(
      await value(relay, 'hookline_outbox_published_total', { kind: 'wait' }),
    ).toBe(1);
    await vi.waitFor(async () => {
      expect(await value(relay, 'hookline_outbox_pending')).toBe(0);
    });
  });

  it('does not count a replayed event again', async () => {
    const before = await value(
      h.registries.api,
      'hookline_events_accepted_total',
    );
    const headers = { 'idempotency-key': 'metrics-replay' };
    for (let i = 0; i < 2; i++) {
      const response = await h.app.inject({
        method: 'POST',
        url: '/v1/events',
        headers: { ...headers, authorization: `Bearer ${h.apiKey}` },
        payload: { type: 'metrics.replay', payload: {} },
      });
      expect(response.statusCode).toBe(202);
    }

    expect(
      await value(h.registries.api, 'hookline_events_accepted_total'),
    ).toBe(before + 1);
  });
});
