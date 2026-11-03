import {
  createGuardedLookup,
  declareTopology,
  declareWaitQueues,
  decideNextStep,
  decryptSecret,
  DELIVERIES_DEAD_ROUTING_KEY,
  DELIVERIES_EXCHANGE,
  DELIVERIES_READY_QUEUE,
  newId,
  parseRetryDelays,
  pickDelay,
  THROTTLE_DELAY,
  waitRoutingKey,
  withTransaction,
  type Broker,
  type NextStep,
  type Pool,
  type PoolClient,
  type RetryDelay,
} from '@hookline/shared';
import type { lookup as dnsLookup } from 'node:dns';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { Logger } from 'pino';
import { Agent } from 'undici';
import { TokenBuckets } from './rate-limiter.js';
import { sendWebhook, type SendResult } from './sender.js';

const ERROR_BACKOFF_MS = 1_000;

export interface CircuitBreakerOptions {
  failureThreshold: number;
  openMs: number;
}

export interface DeliveryWorkerOptions {
  pool: Pool;
  broker: Broker;
  encryptionKey: Buffer;
  logger: Logger;
  prefetch?: number;
  retryDelays?: RetryDelay[];
  maxErrorBackoffMs?: number;
  allowPrivateTargets?: boolean;
  lookup?: typeof dnsLookup;
  circuitBreaker?: CircuitBreakerOptions;
  endpointRateLimitPerSecond?: number;
}

interface DeliveryRow {
  id: string;
  status: string;
  attempt_count: number;
  event_id: string;
  endpoint_id: string;
  type: string;
  payload: unknown;
  created_at: Date;
  url: string;
  secret_encrypted: string;
  previous_secret_encrypted: string | null;
  endpoint_status: string;
  circuit_wait_ms: number | null;
}

interface DeliveryMessage {
  delivery_id: string;
  attempt: number;
}

const FINAL_STATUSES = new Set(['succeeded', 'dead']);

const DELIVERY_STATUS: Record<NextStep['action'], string> = {
  succeed: 'succeeded',
  retry: 'retrying',
  dead: 'dead',
  disable_endpoint: 'dead',
};

function parseMessage(content: Buffer): DeliveryMessage {
  const message = JSON.parse(content.toString()) as Partial<DeliveryMessage>;
  if (
    typeof message.delivery_id !== 'string' ||
    !Number.isInteger(message.attempt)
  ) {
    throw new Error('Unexpected message shape');
  }
  return message as DeliveryMessage;
}

async function enqueue(
  client: PoolClient,
  deliveryId: string,
  routingKey: string,
  attempt: number,
): Promise<void> {
  await client.query(
    `INSERT INTO outbox (delivery_id, routing_key, payload)
     VALUES ($1, $2, jsonb_build_object('delivery_id', $1::uuid, 'attempt', $3::int))`,
    [deliveryId, routingKey, attempt],
  );
}

export function startDeliveryWorker({
  pool,
  broker,
  encryptionKey,
  logger,
  prefetch = 10,
  retryDelays = parseRetryDelays(),
  maxErrorBackoffMs = 30_000,
  allowPrivateTargets = false,
  lookup,
  circuitBreaker = { failureThreshold: 5, openMs: 300_000 },
  endpointRateLimitPerSecond = 50,
}: DeliveryWorkerOptions) {
  const targetPolicy = { allowPrivateTargets };
  const waitDelays = [...retryDelays, THROTTLE_DELAY];
  const rateLimiter = new TokenBuckets(endpointRateLimitPerSecond);
  const dispatcher = new Agent(
    allowPrivateTargets
      ? {}
      : { connect: { lookup: createGuardedLookup(lookup) } },
  );

  async function loadDelivery(id: string): Promise<DeliveryRow | undefined> {
    const { rows } = await pool.query<DeliveryRow>(
      `SELECT d.id, d.status, d.attempt_count, d.event_id, d.endpoint_id,
              e.type, e.payload, e.created_at, ep.url, ep.secret_encrypted,
              CASE WHEN ep.previous_secret_expires_at > now()
                THEN ep.previous_secret_encrypted
              END AS previous_secret_encrypted,
              ep.status AS endpoint_status,
              CASE WHEN ep.circuit_open_until > now()
                THEN extract(epoch FROM ep.circuit_open_until - now()) * 1000
              END::float8 AS circuit_wait_ms
       FROM deliveries d
       JOIN events e ON e.id = d.event_id
       JOIN endpoints ep ON ep.id = d.endpoint_id
       WHERE d.id = $1`,
      [id],
    );
    return rows[0];
  }

  // The attempt and whatever comes next commit together, so a crash can never
  // record a failure and forget to schedule the following attempt.
  async function recordAttempt(
    delivery: DeliveryRow,
    attemptNumber: number,
    result: SendResult,
  ): Promise<void> {
    const next = decideNextStep(
      attemptNumber,
      result.responseStatus,
      retryDelays,
    );
    await withTransaction(pool, async (client) => {
      const { rowCount } = await client.query(
        `INSERT INTO delivery_attempts
           (id, delivery_id, attempt_number, started_at, duration_ms,
            response_status, error_code, response_snippet)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (delivery_id, attempt_number) DO NOTHING`,
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
      // A duplicate message running at the same time recorded this attempt.
      if (!rowCount) {
        return;
      }

      await client.query(
        `UPDATE deliveries
         SET status = $2,
             attempt_count = $3,
             delivered_at = CASE WHEN $2 = 'succeeded' THEN now() END,
             next_attempt_at = now() + $4 * interval '1 millisecond'
         WHERE id = $1`,
        [
          delivery.id,
          DELIVERY_STATUS[next.action],
          attemptNumber,
          next.action === 'retry' ? next.delay.ms : null,
        ],
      );

      if (next.action === 'retry') {
        await enqueue(
          client,
          delivery.id,
          waitRoutingKey(next.delay),
          attemptNumber + 1,
        );
      } else if (next.action !== 'succeed') {
        await enqueue(
          client,
          delivery.id,
          DELIVERIES_DEAD_ROUTING_KEY,
          attemptNumber,
        );
      }
      if (next.action === 'disable_endpoint') {
        await client.query(
          `UPDATE endpoints SET status = 'disabled', updated_at = now()
           WHERE id = $1 AND status = 'active'`,
          [delivery.endpoint_id],
        );
      }

      // The circuit state lives in the database, so every worker sees it.
      // A failure while the circuit was already open, after it expired,
      // opens it again.
      if (next.action === 'succeed') {
        await client.query(
          `UPDATE endpoints
           SET consecutive_failures = 0, circuit_open_until = NULL
           WHERE id = $1
             AND (consecutive_failures <> 0 OR circuit_open_until IS NOT NULL)`,
          [delivery.endpoint_id],
        );
      } else {
        await client.query(
          `UPDATE endpoints
           SET consecutive_failures = consecutive_failures + 1,
               circuit_open_until = CASE
                 WHEN consecutive_failures + 1 >= $2
                   THEN now() + $3 * interval '1 millisecond'
                 ELSE circuit_open_until
               END
           WHERE id = $1`,
          [
            delivery.endpoint_id,
            circuitBreaker.failureThreshold,
            circuitBreaker.openMs,
          ],
        );
      }
    });
  }

  async function abandonDelivery(
    delivery: DeliveryRow,
    attempt: number,
  ): Promise<void> {
    await withTransaction(pool, async (client) => {
      await client.query(
        `UPDATE deliveries SET status = 'dead', next_attempt_at = NULL
         WHERE id = $1`,
        [delivery.id],
      );
      await enqueue(client, delivery.id, DELIVERIES_DEAD_ROUTING_KEY, attempt);
    });
  }

  // Returns a delay when the delivery must wait without spending an attempt.
  async function processDelivery({
    delivery_id: id,
    attempt,
  }: DeliveryMessage): Promise<RetryDelay | undefined> {
    const delivery = await loadDelivery(id);
    if (!delivery) {
      logger.warn({ deliveryId: id }, 'Delivery not found');
      return undefined;
    }
    // A duplicate message: the relay published it twice, or a crash before the
    // ack made the broker redeliver it. This attempt already has its outcome.
    if (
      FINAL_STATUSES.has(delivery.status) ||
      attempt <= delivery.attempt_count
    ) {
      return undefined;
    }
    if (delivery.endpoint_status !== 'active') {
      await abandonDelivery(delivery, attempt);
      return undefined;
    }
    // A failing endpoint gets a break instead of more doomed attempts, and
    // one over its rate limit waits, so neither holds back other endpoints.
    if (delivery.circuit_wait_ms !== null) {
      return pickDelay(retryDelays, delivery.circuit_wait_ms);
    }
    if (!rateLimiter.tryTake(delivery.endpoint_id)) {
      return THROTTLE_DELAY;
    }

    const encryptedSecrets = [
      delivery.secret_encrypted,
      ...(delivery.previous_secret_encrypted
        ? [delivery.previous_secret_encrypted]
        : []),
    ];
    const result = await sendWebhook(
      {
        url: delivery.url,
        secrets: encryptedSecrets.map((secret) =>
          decryptSecret(secret, encryptionKey),
        ),
        id: delivery.event_id,
        body: JSON.stringify({
          type: delivery.type,
          timestamp: delivery.created_at.toISOString(),
          data: delivery.payload,
        }),
      },
      { dispatcher, targetPolicy },
    );
    await recordAttempt(delivery, attempt, result);
    logger.info(
      {
        deliveryId: id,
        attempt,
        status: result.responseStatus,
        errorCode: result.errorCode,
        durationMs: result.durationMs,
      },
      'Delivery attempted',
    );
    return undefined;
  }

  // Publishing straight to the broker is safe here, unlike for retries:
  // nothing changes in the database, and a crash before the ack only
  // redelivers the original message.
  function deferMessage(
    channel: ConfirmChannel,
    message: ConsumeMessage,
    delay: RetryDelay,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      channel.publish(
        DELIVERIES_EXCHANGE,
        waitRoutingKey(delay),
        message.content,
        { persistent: true, contentType: 'application/json' },
        (error) => (error ? reject(error as Error) : resolve()),
      );
    });
  }

  let consecutiveErrors = 0;

  async function handleMessage(
    channel: ConfirmChannel,
    message: ConsumeMessage,
  ): Promise<void> {
    let delivery: DeliveryMessage;
    try {
      delivery = parseMessage(message.content);
    } catch (error) {
      logger.error({ err: error }, 'Discarding malformed message');
      channel.nack(message, false, false);
      return;
    }

    try {
      const deferral = await processDelivery(delivery);
      if (deferral) {
        await deferMessage(channel, message, deferral);
      }
      consecutiveErrors = 0;
      // Acknowledge only after the commit: a crash before this point makes
      // the broker redeliver the message instead of losing the delivery.
      channel.ack(message);
    } catch (error) {
      logger.error(
        { err: error, deliveryId: delivery.delivery_id },
        'Failed to process delivery',
      );
      // This is an internal failure, such as the database being down, not a
      // failed delivery, so it spends no attempt. Waiting keeps a long outage
      // from turning into a tight loop of returned messages.
      consecutiveErrors += 1;
      await sleep(
        Math.min(
          ERROR_BACKOFF_MS * 2 ** (consecutiveErrors - 1),
          maxErrorBackoffMs,
        ),
      );
      channel.nack(message, false, true);
    }
  }

  const channel = broker.createChannel({
    json: false,
    setup: async (ch: ConfirmChannel) => {
      await declareTopology(ch);
      await declareWaitQueues(ch, waitDelays);
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
      await dispatcher.close();
    },
  };
}
