import {
  declareTopology,
  DELIVERIES_EXCHANGE,
  withTransaction,
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
}

interface OutboxRow {
  id: string;
  routing_key: string;
  payload: unknown;
}

export function startRelay({
  pool,
  broker,
  logger,
  batchSize = 100,
  pollIntervalMs = 200,
}: RelayOptions) {
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
        `SELECT id, routing_key, payload FROM outbox
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
          channel.publish(
            DELIVERIES_EXCHANGE,
            row.routing_key,
            Buffer.from(JSON.stringify(row.payload)),
            {
              persistent: true,
              contentType: 'application/json',
              timeout: PUBLISH_TIMEOUT_MS,
            },
          ),
        ),
      );

      await client.query(
        'UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])',
        [rows.map((row) => row.id)],
      );
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
