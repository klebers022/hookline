import {
  declareTopology,
  decryptSecret,
  DELIVERIES_READY_QUEUE,
  newId,
  withTransaction,
  type Broker,
  type Pool,
} from '@hookline/shared';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { Logger } from 'pino';
import { sendWebhook, type SendResult } from './sender.js';

export interface DeliveryWorkerOptions {
  pool: Pool;
  broker: Broker;
  encryptionKey: Buffer;
  logger: Logger;
  prefetch?: number;
}

interface DeliveryRow {
  id: string;
  status: string;
  attempt_count: number;
  event_id: string;
  type: string;
  payload: unknown;
  created_at: Date;
  url: string;
  secret_encrypted: string;
  endpoint_status: string;
}

const FINAL_STATUSES = new Set(['succeeded', 'dead']);

function isSuccess({ responseStatus }: SendResult): boolean {
  return (
    responseStatus !== null && responseStatus >= 200 && responseStatus < 300
  );
}

export function startDeliveryWorker({
  pool,
  broker,
  encryptionKey,
  logger,
  prefetch = 10,
}: DeliveryWorkerOptions) {
  async function loadDelivery(id: string): Promise<DeliveryRow | undefined> {
    const { rows } = await pool.query<DeliveryRow>(
      `SELECT d.id, d.status, d.attempt_count, d.event_id, e.type, e.payload,
              e.created_at, ep.url, ep.secret_encrypted,
              ep.status AS endpoint_status
       FROM deliveries d
       JOIN events e ON e.id = d.event_id
       JOIN endpoints ep ON ep.id = d.endpoint_id
       WHERE d.id = $1`,
      [id],
    );
    return rows[0];
  }

  async function recordAttempt(
    delivery: DeliveryRow,
    attemptNumber: number,
    result: SendResult,
  ): Promise<void> {
    const succeeded = isSuccess(result);
    await withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO delivery_attempts
           (id, delivery_id, attempt_number, started_at, duration_ms,
            response_status, error_code, response_snippet)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          newId(),
          delivery.id,
          attemptNumber,
          result.startedAt,
          result.durationMs,
          result.responseStatus,
          result.errorCode,
          result.responseSnippet,
        ],
      );
      // Failures are final until retries and the DLQ arrive in phase 2.
      await client.query(
        `UPDATE deliveries
         SET status = $2,
             attempt_count = $3,
             delivered_at = CASE WHEN $2 = 'succeeded' THEN now() END
         WHERE id = $1`,
        [delivery.id, succeeded ? 'succeeded' : 'dead', attemptNumber],
      );
    });
  }

  async function processDelivery(id: string): Promise<void> {
    const delivery = await loadDelivery(id);
    if (!delivery) {
      logger.warn({ deliveryId: id }, 'Delivery not found');
      return;
    }
    // A duplicate message: the outcome of this delivery is already recorded.
    if (FINAL_STATUSES.has(delivery.status)) {
      return;
    }
    if (delivery.endpoint_status !== 'active') {
      await pool.query(`UPDATE deliveries SET status = 'dead' WHERE id = $1`, [
        id,
      ]);
      return;
    }

    const result = await sendWebhook({
      url: delivery.url,
      secret: decryptSecret(delivery.secret_encrypted, encryptionKey),
      id: delivery.event_id,
      body: JSON.stringify({
        type: delivery.type,
        timestamp: delivery.created_at.toISOString(),
        data: delivery.payload,
      }),
    });
    await recordAttempt(delivery, delivery.attempt_count + 1, result);
    logger.info(
      {
        deliveryId: id,
        status: result.responseStatus,
        errorCode: result.errorCode,
        durationMs: result.durationMs,
      },
      'Delivery attempted',
    );
  }

  async function handleMessage(
    channel: ConfirmChannel,
    message: ConsumeMessage,
  ): Promise<void> {
    let deliveryId: string;
    try {
      const parsed = JSON.parse(message.content.toString()) as {
        delivery_id: string;
      };
      deliveryId = parsed.delivery_id;
    } catch (error) {
      logger.error({ err: error }, 'Discarding malformed message');
      channel.nack(message, false, false);
      return;
    }

    try {
      await processDelivery(deliveryId);
      // Acknowledge only after the commit: a crash before this point makes
      // the broker redeliver the message instead of losing the delivery.
      channel.ack(message);
    } catch (error) {
      logger.error({ err: error, deliveryId }, 'Failed to process delivery');
      channel.nack(message, false, true);
    }
  }

  const channel = broker.createChannel({
    json: false,
    setup: async (ch: ConfirmChannel) => {
      await declareTopology(ch);
      await ch.prefetch(prefetch);
      await ch.consume(DELIVERIES_READY_QUEUE, (message) => {
        if (message) {
          handleMessage(ch, message).catch((error: unknown) => {
            logger.error({ err: error }, 'Failed to settle message');
          });
        }
      });
    },
  });

  return {
    async stop(): Promise<void> {
      await channel.close();
    },
  };
}
