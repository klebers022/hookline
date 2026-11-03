import { createProject } from '@hookline/api';
import { DELIVERIES_DLQ_QUEUE, type Pool } from '@hookline/shared';
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

describe('delivery retries', () => {
  let h: Harness;

  // Sent through the outbox, like a relay that crashed before marking a row.
  async function insertDuplicate(deliveryId: string, attempt: number) {
    await h.pool.query(
      `INSERT INTO outbox (delivery_id, routing_key, payload)
       VALUES ($1, 'delivery.ready',
               jsonb_build_object('delivery_id', $1::uuid, 'attempt', $2::int))`,
      [deliveryId, attempt],
    );
  }

  function callsFor(eventId: string): number {
    return h.receiver.received.filter((item) => item.id === eventId).length;
  }

  async function dlqDepth(): Promise<number> {
    const { messageCount } = await h.inspector.checkQueue(DELIVERIES_DLQ_QUEUE);
    return messageCount;
  }

  async function history(deliveryId: string) {
    const { body } = await h.call('GET', `/v1/deliveries/${deliveryId}`);
    return body as {
      status: string;
      attempt_count: number;
      next_attempt_at: string | null;
      delivered_at: string | null;
      attempts: { attempt_number: number; response_status: number | null }[];
    };
  }

  async function exhaust(type: string) {
    await h.createEndpoint([type]);
    h.receiver.configure({ status: 500 });
    const event = await h.publish(type);
    const delivery = await h.waitForDelivery(event.id, 'dead');
    return { event, delivery };
  }

  beforeAll(async () => {
    // With 1-second waits, six failures in a row would open the circuit
    // breaker, which is tested on its own.
    h = await startHarness('1s,1s,1s,1s,1s', {
      circuitBreaker: { failureThreshold: 100, openMs: 1_000 },
    });
  });

  afterAll(async () => {
    await h?.stop();
  });

  beforeEach(() => {
    h.receiver.configure({ status: 200, delay_ms: 0, fail_next: 0 });
  });

  it('retries until the endpoint recovers', async () => {
    await h.createEndpoint(['retry.recovers']);
    h.receiver.configure({ fail_next: 2 });

    const event = await h.publish('retry.recovers');

    const waiting = await h.waitForDelivery(event.id, 'retrying');
    expect(waiting.next_attempt_at).not.toBeNull();

    const delivery = await h.waitForDelivery(event.id, 'succeeded');
    const result = await history(delivery.id);
    expect(result.attempts.map((item) => item.response_status)).toEqual([
      500, 500, 200,
    ]);
    expect(result.delivered_at).not.toBeNull();
    expect(result.next_attempt_at).toBeNull();
  });

  it('moves the delivery to the DLQ when attempts run out', async () => {
    const before = await dlqDepth();

    const { event, delivery } = await exhaust('retry.exhausted');

    const result = await history(delivery.id);
    expect(result.attempts.map((item) => item.attempt_number)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(result.delivered_at).toBeNull();
    expect(result.next_attempt_at).toBeNull();
    expect(callsFor(event.id)).toBe(6);
    await vi.waitFor(async () => expect(await dlqDepth()).toBe(before + 1), {
      timeout: 5_000,
    });
  });

  it('ignores a duplicate of an attempt that already succeeded', async () => {
    await h.createEndpoint(['duplicate.final']);
    const event = await h.publish('duplicate.final');
    const delivery = await h.waitForDelivery(event.id, 'succeeded');

    await insertDuplicate(delivery.id, 1);
    // Delivered after the duplicate, so the duplicate was already handled.
    await h.createEndpoint(['duplicate.marker']);
    const marker = await h.publish('duplicate.marker');
    await h.waitForDelivery(marker.id, 'succeeded');

    expect(callsFor(event.id)).toBe(1);
    expect((await history(delivery.id)).attempt_count).toBe(1);
  });

  it('ignores a duplicate that arrives during the wait', async () => {
    await h.createEndpoint(['duplicate.waiting']);
    h.receiver.configure({ fail_next: 1 });
    const event = await h.publish('duplicate.waiting');
    const waiting = await h.waitForDelivery(event.id, 'retrying');

    await insertDuplicate(waiting.id, 1);

    await h.waitForDelivery(event.id, 'succeeded');
    expect(callsFor(event.id)).toBe(2);
  });

  it('disables the endpoint on 410 Gone', async () => {
    const { id } = await h.createEndpoint(['gone.event']);
    h.receiver.configure({ status: 410 });

    const event = await h.publish('gone.event');
    const delivery = await h.waitForDelivery(event.id, 'dead');

    expect((await history(delivery.id)).attempt_count).toBe(1);
    const { body } = await h.call('GET', `/v1/endpoints/${id}`);
    expect(body.status).toBe('disabled');
  });

  it('abandons the wait when the endpoint is disabled', async () => {
    const { id } = await h.createEndpoint(['disabled.waiting']);
    h.receiver.configure({ fail_next: 1 });
    const event = await h.publish('disabled.waiting');
    const waiting = await h.waitForDelivery(event.id, 'retrying');

    await h.call('PATCH', `/v1/endpoints/${id}`, { status: 'disabled' });

    await h.waitForDelivery(event.id, 'dead');
    expect((await history(waiting.id)).attempt_count).toBe(1);
  });

  it('gives an exhausted delivery one more attempt on a manual retry', async () => {
    const { event, delivery } = await exhaust('manual.success');
    h.receiver.configure({ status: 200 });

    const { status, body } = await h.call(
      'POST',
      `/v1/deliveries/${delivery.id}/retry`,
    );

    expect(status).toBe(202);
    expect(body).toMatchObject({ status: 'pending', attempt: 7 });
    await h.waitForDelivery(event.id, 'succeeded');
    expect((await history(delivery.id)).attempt_count).toBe(7);
  });

  it('returns to dead when the manual retry also fails', async () => {
    const { event, delivery } = await exhaust('manual.failure');

    await h.call('POST', `/v1/deliveries/${delivery.id}/retry`);

    await vi.waitFor(() => expect(callsFor(event.id)).toBe(7), {
      timeout: 5_000,
    });
    await h.waitForDelivery(event.id, 'dead');
    expect((await history(delivery.id)).attempt_count).toBe(7);
  });

  it('refuses a manual retry that cannot run', async () => {
    await h.createEndpoint(['manual.refused']);
    const event = await h.publish('manual.refused');
    const delivered = await h.waitForDelivery(event.id, 'succeeded');
    const notDead = await h.call(
      'POST',
      `/v1/deliveries/${delivered.id}/retry`,
    );
    expect(notDead.status).toBe(409);

    await h.createEndpoint(['manual.gone']);
    h.receiver.configure({ status: 410 });
    const gone = await h.publish('manual.gone');
    const dead = await h.waitForDelivery(gone.id, 'dead');
    const disabled = await h.call('POST', `/v1/deliveries/${dead.id}/retry`);
    expect(disabled.status).toBe(409);

    const other = await createProject(h.pool, 'other');
    const foreign = await h.call(
      'POST',
      `/v1/deliveries/${dead.id}/retry`,
      undefined,
      other.apiKey,
    );
    expect(foreign.status).toBe(404);
  });

  it('publishes what was accepted while the relay was down', async () => {
    await h.createEndpoint(['relay.restart']);
    await h.processes.relay.stop();

    const event = await h.publish('relay.restart');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(callsFor(event.id)).toBe(0);

    h.processes.relay = h.newRelay();
    await h.waitForDelivery(event.id, 'succeeded');
  });

  it('keeps a message through more failures than the default delivery limit', async () => {
    let failures = 0;
    const flakyPool = new Proxy(h.pool, {
      get(target, property) {
        if (property === 'query' && failures < 25) {
          return async () => {
            failures += 1;
            throw new Error('database is down');
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Pool;

    await h.createEndpoint(['database.outage']);
    await h.processes.worker.stop();
    h.processes.worker = h.newWorker({
      pool: flakyPool,
      maxErrorBackoffMs: 1,
    });

    const event = await h.publish('database.outage');
    await h.waitForDelivery(event.id, 'succeeded');

    expect(failures).toBe(25);
    expect(callsFor(event.id)).toBe(1);
  });
});
