import { startReceiver } from '@hookline/test-receiver';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { startHarness, type Harness } from './harness.js';

describe('endpoint isolation', () => {
  let h: Harness;
  let other: Awaited<ReturnType<typeof startReceiver>>;

  async function endpointFor(url: string, type: string) {
    const { status, body } = await h.call('POST', '/v1/endpoints', {
      url: `${url}/hooks`,
      event_types: [type],
    });
    expect(status).toBe(201);
    return body as { id: string };
  }

  async function endpointState(id: string) {
    const { body } = await h.call('GET', `/v1/endpoints/${id}`);
    return body as {
      consecutive_failures: number;
      circuit_open_until: string | null;
    };
  }

  async function attemptCount(eventId: string): Promise<number> {
    const { body } = await h.call('GET', `/v1/events/${eventId}`);
    return body.deliveries[0].attempt_count;
  }

  function callsFor(eventId: string): number {
    return h.receiver.received.filter((item) => item.id === eventId).length;
  }

  beforeAll(async () => {
    h = await startHarness('1s,1s,1s,1s,1s', {
      circuitBreaker: { failureThreshold: 3, openMs: 3_000 },
      endpointRateLimitPerSecond: 2,
    });
    other = await startReceiver();
  });

  afterAll(async () => {
    await other?.stop();
    await h?.stop();
  });

  beforeEach(() => {
    h.receiver.configure({ status: 200, delay_ms: 0, fail_next: 0 });
  });

  describe('circuit breaker', () => {
    it('stops calling a failing endpoint without spending attempts', async () => {
      const { id } = await endpointFor(h.receiver.url, 'circuit.opens');
      h.receiver.configure({ status: 500 });

      const failing = await Promise.all(
        [1, 2, 3].map(() => h.publish('circuit.opens')),
      );
      await vi.waitFor(
        async () => {
          const state = await endpointState(id);
          expect(state.consecutive_failures).toBeGreaterThanOrEqual(3);
          expect(state.circuit_open_until).not.toBeNull();
        },
        { timeout: 10_000 },
      );

      const blocked = await h.publish('circuit.opens');
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(callsFor(blocked.id)).toBe(0);
      expect(await attemptCount(blocked.id)).toBe(0);

      // Once the circuit expires, the endpoint is tried again and recovers.
      h.receiver.configure({ status: 200 });
      for (const event of [...failing, blocked]) {
        await h.waitForDelivery(event.id, 'succeeded');
      }
      expect(await attemptCount(blocked.id)).toBe(1);
      expect(await endpointState(id)).toMatchObject({
        consecutive_failures: 0,
        circuit_open_until: null,
      });
    });

    it('does not hold back other endpoints', async () => {
      await endpointFor(h.receiver.url, 'circuit.noisy');
      await endpointFor(other.url, 'circuit.healthy');
      h.receiver.configure({ status: 500 });

      await Promise.all([1, 2, 3, 4].map(() => h.publish('circuit.noisy')));
      const healthy = await h.publish('circuit.healthy');

      await h.waitForDelivery(healthy.id, 'succeeded');
      expect(
        other.received.filter((item) => item.id === healthy.id),
      ).toHaveLength(1);
    });

    it('closes the circuit when the endpoint is activated again', async () => {
      const { id } = await endpointFor(h.receiver.url, 'circuit.reset');
      h.receiver.configure({ status: 500 });
      await Promise.all([1, 2, 3].map(() => h.publish('circuit.reset')));
      await vi.waitFor(
        async () =>
          expect((await endpointState(id)).circuit_open_until).not.toBeNull(),
        { timeout: 10_000 },
      );

      await h.call('PATCH', `/v1/endpoints/${id}`, { status: 'active' });

      expect(await endpointState(id)).toMatchObject({
        consecutive_failures: 0,
        circuit_open_until: null,
      });
    });
  });

  describe('endpoint rate limit', () => {
    it('spreads a burst over time without spending attempts', async () => {
      await endpointFor(other.url, 'rate.burst');

      const events = await Promise.all(
        [1, 2, 3, 4, 5, 6].map(() => h.publish('rate.burst')),
      );
      for (const event of events) {
        await h.waitForDelivery(event.id, 'succeeded');
      }

      const times = other.received
        .filter((item) => events.some((event) => event.id === item.id))
        .map((item) => Date.parse(item.received_at))
        .sort((a, b) => a - b);
      expect(times).toHaveLength(6);
      // Two go out at once and the rest wait for tokens at 2 per second.
      expect(times.at(-1)! - times[0]!).toBeGreaterThanOrEqual(1_500);
      for (const event of events) {
        expect(await attemptCount(event.id)).toBe(1);
      }
    });
  });
});
