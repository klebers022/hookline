import { createProject } from '@hookline/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

describe('webhook delivery', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.stop();
  });

  beforeEach(() => {
    h.receiver.configure({ status: 200, delay_ms: 0, fail_next: 0 });
  });

  it('delivers a signed event and records it in the history', async () => {
    const { secret } = await h.createEndpoint(['payment.approved']);
    h.receiver.configure({ secret });

    const event = await h.publish('payment.approved', { amount: 4200 });
    expect(event.deliveries).toBe(1);

    const delivery = await h.waitForDelivery(event.id, 'succeeded');

    const webhook = h.receiver.received.find((item) => item.id === event.id);
    expect(webhook?.signature_valid).toBe(true);
    expect(webhook?.body).toMatchObject({
      type: 'payment.approved',
      data: { amount: 4200 },
    });

    const { body: history } = await h.call(
      'GET',
      `/v1/deliveries/${delivery.id}`,
    );
    expect(history.attempt_count).toBe(1);
    expect(history.delivered_at).not.toBeNull();
    expect(history.attempts).toHaveLength(1);
    expect(history.attempts[0]).toMatchObject({
      attempt_number: 1,
      response_status: 200,
      error_code: null,
    });
  });

  it('marks the outbox row as published', async () => {
    await h.createEndpoint(['order.created']);
    const event = await h.publish('order.created');
    const delivery = await h.waitForDelivery(event.id, 'succeeded');

    const { rows } = await h.pool.query(
      'SELECT published_at FROM outbox WHERE delivery_id = $1',
      [delivery.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].published_at).not.toBeNull();
  });

  it('creates one delivery per subscribed endpoint', async () => {
    await h.createEndpoint(['user.created']);
    await h.createEndpoint(['user.created', 'user.deleted']);

    const event = await h.publish('user.created');

    expect(event.deliveries).toBe(2);
  });

  it('creates no delivery when no endpoint subscribes to the type', async () => {
    const event = await h.publish('nobody.listens');

    expect(event.deliveries).toBe(0);
  });

  it('never returns the endpoint secret after creation', async () => {
    const { id } = await h.createEndpoint(['secret.check']);

    const { body } = await h.call('GET', `/v1/endpoints/${id}`);

    expect(body).not.toHaveProperty('secret');
    expect(body).not.toHaveProperty('secret_encrypted');
  });

  it('rejects requests without a valid API key', async () => {
    const missing = await h.app.inject({ method: 'GET', url: '/v1/events' });
    const invalid = await h.call('GET', '/v1/events', undefined, 'hk_invalid');

    expect(missing.statusCode).toBe(401);
    expect(missing.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(invalid.status).toBe(401);
  });

  it('isolates data between projects', async () => {
    const { id } = await h.createEndpoint(['isolated.event']);
    const event = await h.publish('isolated.event');
    const other = await createProject(h.pool, 'other');

    const endpoint = await h.call(
      'GET',
      `/v1/endpoints/${id}`,
      undefined,
      other.apiKey,
    );
    const foreignEvent = await h.call(
      'GET',
      `/v1/events/${event.id}`,
      undefined,
      other.apiKey,
    );

    expect(endpoint.status).toBe(404);
    expect(foreignEvent.status).toBe(404);
  });

  it('rejects an endpoint with an unsupported URL scheme', async () => {
    const { status } = await h.call('POST', '/v1/endpoints', {
      url: 'ftp://example.com/hooks',
      event_types: ['any.event'],
    });

    expect(status).toBe(400);
  });
});
