import {
  Counter,
  declareTopology,
  DELIVERIES_EXCHANGE,
  Gauge,
  Registry,
  withPublishSpan,
  withTransaction,
  type TraceCarrier,
  type Broker,
  type Pool,
} from '@hookline/shared';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ConfirmChannel } from 'amqplib';
import type { Logger } from 'pino';

const PUBLISH_TIMEOUT_MS = 5_000;
const ERROR_BACKOFF_MS = 1_000;

export interface RelayOptions {
  pool: Pool;
  broker: Broker;
  logger: Logger;
  batchSize?: number;
  pollIntervalMs?: number;
  registry?: Registry;
}

interface OutboxRow {
  id: string;
  routing_key: string;
  payload: { delivery_id?: string; attempt?: number };
  trace_context: TraceCarrier | null;
}

// delivery.ready, delivery.wait.5m and delivery.dead become ready, wait and
// dead, a label with a fixed set of values.
function routingKind(routingKey: string): string {
  return routingKey.split('.')[1] ?? 'unknown';
}

// These read the database's state on each scrape, so every relay replica
// reports the same values and dashboards take their max(). A failed read
// keeps the last value instead of failing the whole scrape.
function createOutboxMetrics(registry: Registry, pool: Pool, logger: Logger) {
  const registers = [registry];

  function gauge(name: string, help: string, sql: string): Gauge {
    return new Gauge({
      name,
      help,
      registers,
      async collect() {
        try {
          const { rows } = await pool.query<{ value: number }>(sql);
          this.set(rows[0]?.value ?? 0);
        } catch (error) {
          logger.warn({ err: error, metric: name }, 'Failed to read metric');
        }
      },
    });
  }

  gauge(
    'hookline_outbox_pending',
    'Outbox rows waiting to be published.',
    'SELECT count(*)::int AS value FROM outbox WHERE published_at IS NULL',
  );
  // Grows only when publishing stops, so it is the outbox's health signal.
  gauge(
    'hookline_outbox_oldest_pending_age_seconds',
    'Age of the oldest outbox row waiting to be published.',
    `SELECT coalesce(extract(epoch FROM now() - min(created_at)), 0)::float8
       AS value
     FROM (SELECT created_at FROM outbox WHERE published_at IS NULL
           ORDER BY id LIMIT 1) oldest`,
  );
  gauge(
    'hookline_endpoints_circuit_open',
    'Endpoints whose circuit breaker is open.',
    `SELECT count(*)::int AS value FROM endpoints
     WHERE circuit_open_until > now()`,
  );

  return {
    published: new Counter({
      name: 'hookline_outbox_published_total',
      help: 'Outbox rows published to RabbitMQ, by kind of message.',
      labelNames: ['kind'] as const,
      registers,
    }),
    publishErrors: new Counter({
      name: 'hookline_outbox_publish_errors_total',
      help: 'Batches that failed to publish and will be tried again.',
      registers,
    }),
  };
}

export function startRelay({
  pool,
  broker,
  logger,
  batchSize = 100,
  pollIntervalMs = 200,
  registry = new Registry(),
}: RelayOptions) {
  const metrics = createOutboxMetrics(registry, pool, logger);
  const channel = broker.createChannel({
    json: false,
    setup: (ch: ConfirmChannel) => declareTopology(ch),
  });

  // Row locks let several relays run without publishing the same rows at once.
  // A crash after the confirm and before the commit publishes a row again,
  // which is why the delivery worker must tolerate duplicates.
  async function publishBatch(): Promise<number> {
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query<OutboxRow>(
        `SELECT id, routing_key, payload, trace_context FROM outbox
         WHERE published_at IS NULL
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [batchSize],
      );
      if (rows.length === 0) {
        return 0;
      }

      await Promise.all(
        rows.map((row) =>
          // In the trace of whoever wrote the row, which the message headers
          // carry on to the delivery worker.
          withPublishSpan(
            `publish ${row.routing_key}`,
            row.trace_context,
            {
              'messaging.system': 'rabbitmq',
              'messaging.operation.type': 'send',
              'messaging.destination.name': DELIVERIES_EXCHANGE,
              'messaging.rabbitmq.destination.routing_key': row.routing_key,
              'hookline.delivery.id': row.payload.delivery_id ?? '',
              'hookline.delivery.attempt': row.payload.attempt ?? 0,
            },
            (headers) =>
              channel.publish(
                DELIVERIES_EXCHANGE,
                row.routing_key,
                Buffer.from(JSON.stringify(row.payload)),
                {
                  persistent: true,
                  contentType: 'application/json',
                  timeout: PUBLISH_TIMEOUT_MS,
                  headers,
                },
              ),
          ),
        ),
      );

      await client.query(
        'UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])',
        [rows.map((row) => row.id)],
      );
      for (const row of rows) {
        metrics.published.inc({ kind: routingKind(row.routing_key) });
      }
      return rows.length;
    });
  }

  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        const published = await publishBatch();
        if (published < batchSize) {
          await sleep(pollIntervalMs);
        }
      } catch (error) {
        logger.error({ err: error }, 'Failed to publish outbox batch');
        metrics.publishErrors.inc();
        await sleep(ERROR_BACKOFF_MS);
      }
    }
  })();

  return {
    async stop(): Promise<void> {
      stopped = true;
      await loop;
      await channel.close();
    },
  };
}
