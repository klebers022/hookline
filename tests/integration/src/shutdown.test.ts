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

describe('graceful shutdown', () => {
  let h: Harness;

  function callsFor(eventId: string): number {
    return h.receiver.received.filter((item) => item.id === eventId).length;
  }

  async function deliveryOf(eventId: string) {
    const { body } = await h.call('GET', `/v1/events/${eventId}`);
    return body.deliveries[0] as { status: string; attempt_count: number };
  }

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.stop();
  });

  beforeEach(() => {
    h.receiver.configure({ status: 200, delay_ms: 0, fail_next: 0 });
  });

  it('finishes a delivery in progress before stopping', async () => {
    await h.createEndpoint(['shutdown.inflight']);
    h.receiver.configure({ delay_ms: 1_500 });
    const event = await h.publish('shutdown.inflight');
    await vi.waitFor(() => expect(callsFor(event.id)).toBe(1), {
      timeout: 10_000,
    });

    await h.processes.worker.stop();

    // Recorded before stop() returned, not after a redelivery.
    expect(await deliveryOf(event.id)).toMatchObject({
      status: 'succeeded',
      attempt_count: 1,
    });

    h.processes.worker = h.newWorker();
  });

  it('takes no new message after stopping', async () => {
    await h.createEndpoint(['shutdown.idle']);
    await h.processes.worker.stop();

    const event = await h.publish('shutdown.idle');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(callsFor(event.id)).toBe(0);
    expect((await deliveryOf(event.id)).status).toBe('pending');

    h.processes.worker = h.newWorker();
    await h.waitForDelivery(event.id, 'succeeded');
  });

  it('gives up waiting at the deadline without losing the delivery', async () => {
    await h.processes.worker.stop();
    h.processes.worker = h.newWorker({ shutdownTimeoutMs: 200 });
    await h.createEndpoint(['shutdown.deadline']);
    h.receiver.configure({ delay_ms: 3_000 });
    const event = await h.publish('shutdown.deadline');
    await vi.waitFor(() => expect(callsFor(event.id)).toBe(1), {
      timeout: 10_000,
    });

    const started = Date.now();
    await h.processes.worker.stop();
    expect(Date.now() - started).toBeLessThan(2_000);

    h.receiver.configure({ delay_ms: 0 });
    h.processes.worker = h.newWorker();
    await h.waitForDelivery(event.id, 'succeeded');
    expect((await deliveryOf(event.id)).attempt_count).toBe(1);
  });

  it('can be stopped more than once', async () => {
    const worker = h.newWorker();

    await worker.stop();
    await expect(worker.stop()).resolves.toBeUndefined();
  });
});
