import { buildApp, createProject, runMigrations } from '@hookline/api';
import { connectBroker, createPool, parseRetryDelays } from '@hookline/shared';
import { startReceiver } from '@hookline/test-receiver';
import { startDeliveryWorker, startRelay } from '@hookline/worker';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';
import { randomBytes } from 'node:crypto';
import { pino } from 'pino';
import { expect, vi } from 'vitest';

const encryptionKey = randomBytes(32);
const logger = pino({ level: 'silent' });

type Method = 'GET' | 'POST' | 'PATCH';

export type Harness = Awaited<ReturnType<typeof startHarness>>;

type WorkerOptions = Partial<Parameters<typeof startDeliveryWorker>[0]>;

export async function startHarness(
  retrySchedule?: string,
  workerDefaults: WorkerOptions = {},
) {
  const [postgres, rabbit] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new RabbitMQContainer('rabbitmq:4.1-management-alpine').start(),
  ]);
  await runMigrations(postgres.getConnectionUri());

  const pool = createPool(postgres.getConnectionUri());
  const broker = connectBroker(rabbit.getAmqpUrl());
  // The test receiver runs on localhost, which production would block.
  const app = await buildApp({
    pool,
    encryptionKey,
    allowPrivateTargets: true,
  });
  const receiver = await startReceiver();
  const retryDelays = parseRetryDelays(retrySchedule);
  const { apiKey } = await createProject(pool, 'test');

  // Used only to inspect the queues; the topology belongs to the processes.
  const inspector = broker.createChannel({ json: false });

  function newRelay() {
    return startRelay({ pool, broker, logger, pollIntervalMs: 50 });
  }

  function newWorker(options: WorkerOptions = {}) {
    return startDeliveryWorker({
      pool,
      broker,
      encryptionKey,
      logger,
      retryDelays,
      allowPrivateTargets: true,
      ...workerDefaults,
      ...options,
    });
  }

  const processes = { relay: newRelay(), worker: newWorker() };

  async function call(
    method: Method,
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
        return delivery as { id: string; next_attempt_at: string | null };
      },
      { timeout: 25_000, interval: 100 },
    );
  }

  async function stop() {
    await processes.relay.stop();
    await processes.worker.stop();
    await inspector.close();
    await receiver.stop();
    await broker.close();
    await app.close();
    await pool.end();
    await Promise.all([postgres.stop(), rabbit.stop()]);
  }

  return {
    app,
    encryptionKey,
    apiKey,
    pool,
    receiver,
    inspector,
    processes,
    newRelay,
    newWorker,
    call,
    createEndpoint,
    publish,
    waitForDelivery,
    stop,
  };
}
