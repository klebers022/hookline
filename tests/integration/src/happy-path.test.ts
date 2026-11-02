import { buildApp, createProject } from '@hookline/api';
import {
  connectBroker,
  createPool,
  runMigrations,
  type Broker,
  type Pool,
} from '@hookline/shared';
import { startReceiver } from '@hookline/test-receiver';
import { startDeliveryWorker, startRelay } from '@hookline/worker';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  RabbitMQContainer,
  type StartedRabbitMQContainer,
} from '@testcontainers/rabbitmq';
import { randomBytes } from 'node:crypto';
import { pino } from 'pino';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const encryptionKey = randomBytes(32);
const logger = pino({ level: 'silent' });

describe('webhook delivery', () => {
  let postgres: StartedPostgreSqlContainer;
  let rabbit: StartedRabbitMQContainer;
  let pool: Pool;
  let broker: Broker;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let receiver: Awaited<ReturnType<typeof startReceiver>>;
  let relay: ReturnType<typeof startRelay>;
  let worker: ReturnType<typeof startDeliveryWorker>;
  let apiKey: string;

  async function call(
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
    key = apiKey,
  ) {
    const response = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${key}` },
      ...(payload && { payload }),
    });
    return { status: response.statusCode, body: response.json() };
  }

  async function createEndpoint(eventTypes: string[]) {
    const { status, body } = await call('POST', '/v1/endpoints', {
      url: `${receiver.url}/hooks`,
      event_types: eventTypes,
    });
    expect(status).toBe(201);
    return body as { id: string; secret: string };
  }

  async function publish(type: string, payload: object = { amount: 100 }) {
    const { status, body } = await call('POST', '/v1/events', {
      type,
      payload,
    });
    expect(status).toBe(202);
    return body as { id: string; deliveries: number };
  }

  async function waitForDelivery(eventId: string, finalStatus: string) {
    return vi.waitFor(
      async () => {
        const { body } = await call('GET', `/v1/events/${eventId}`);
        const delivery = body.deliveries[0];
        expect(delivery.status).toBe(finalStatus);
        return delivery as { id: string };
      },
      { timeout: 15_000, interval: 100 },
    );
  }

  beforeAll(async () => {
    [postgres, rabbit] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine').start(),
      new RabbitMQContainer('rabbitmq:4.1-management-alpine').start(),
    ]);
    await runMigrations(postgres.getConnectionUri());

    pool = createPool(postgres.getConnectionUri());
    broker = connectBroker(rabbit.getAmqpUrl());
    app = await buildApp({ pool, encryptionKey });
    receiver = await startReceiver();
    relay = startRelay({ pool, broker, logger, pollIntervalMs: 50 });
    worker = startDeliveryWorker({ pool, broker, encryptionKey, logger });
    ({ apiKey } = await createProject(pool, 'test'));
  });

  afterAll(async () => {
    await relay?.stop();
    await worker?.stop();
    await receiver?.stop();
    await broker?.close();
    await app?.close();
    await pool?.end();
    await Promise.all([postgres?.stop(), rabbit?.stop()]);
  });

  beforeEach(() => {
    receiver.configure({ status: 200, delay_ms: 0 });
  });

  it('delivers a signed event and records it in the history', async () => {
    const { secret } = await createEndpoint(['payment.approved']);
    receiver.configure({ secret });

    const event = await publish('payment.approved', { amount: 4200 });
    expect(event.deliveries).toBe(1);

    const delivery = await waitForDelivery(event.id, 'succeeded');

    const webhook = receiver.received.find((item) => item.id === event.id);
    expect(webhook?.signature_valid).toBe(true);
    expect(webhook?.body).toMatchObject({
      type: 'payment.approved',
      data: { amount: 4200 },
    });

    const { body: history } = await call(
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
    await createEndpoint(['order.created']);
    const event = await publish('order.created');
    const delivery = await waitForDelivery(event.id, 'succeeded');

    const { rows } = await pool.query(
      'SELECT published_at FROM outbox WHERE delivery_id = $1',
      [delivery.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].published_at).not.toBeNull();
  });

  it('creates one delivery per subscribed endpoint', async () => {
    await createEndpoint(['user.created']);
    await createEndpoint(['user.created', 'user.deleted']);

    const event = await publish('user.created');

    expect(event.deliveries).toBe(2);
  });

  it('creates no delivery when no endpoint subscribes to the type', async () => {
    const event = await publish('nobody.listens');

    expect(event.deliveries).toBe(0);
  });

  it('records a failed attempt', async () => {
    await createEndpoint(['invoice.failed']);
    receiver.configure({ status: 500 });

    const event = await publish('invoice.failed');
    const delivery = await waitForDelivery(event.id, 'dead');

    const { body } = await call('GET', `/v1/deliveries/${delivery.id}`);
    expect(body.attempts[0].response_status).toBe(500);
    expect(body.delivered_at).toBeNull();
  });

  it('never returns the endpoint secret after creation', async () => {
    const { id } = await createEndpoint(['secret.check']);

    const { body } = await call('GET', `/v1/endpoints/${id}`);

    expect(body).not.toHaveProperty('secret');
    expect(body).not.toHaveProperty('secret_encrypted');
  });

  it('rejects requests without a valid API key', async () => {
    const missing = await app.inject({ method: 'GET', url: '/v1/events' });
    const invalid = await call('GET', '/v1/events', undefined, 'hk_invalid');

    expect(missing.statusCode).toBe(401);
    expect(missing.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(invalid.status).toBe(401);
  });

  it('isolates data between projects', async () => {
    const { id } = await createEndpoint(['isolated.event']);
    const event = await publish('isolated.event');
    const other = await createProject(pool, 'other');

    const endpoint = await call(
      'GET',
      `/v1/endpoints/${id}`,
      undefined,
      other.apiKey,
    );
    const foreignEvent = await call(
      'GET',
      `/v1/events/${event.id}`,
      undefined,
      other.apiKey,
    );

    expect(endpoint.status).toBe(404);
    expect(foreignEvent.status).toBe(404);
  });

  it('rejects an endpoint with an unsupported URL scheme', async () => {
    const { status } = await call('POST', '/v1/endpoints', {
      url: 'ftp://example.com/hooks',
      event_types: ['any.event'],
    });

    expect(status).toBe(400);
  });
});
