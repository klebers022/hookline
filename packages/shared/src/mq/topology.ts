import amqp, { type AmqpConnectionManager } from 'amqp-connection-manager';
import type { ConfirmChannel } from 'amqplib';
import type { RetryDelay } from '../retry-policy.js';

export type Broker = AmqpConnectionManager;

export const DELIVERIES_EXCHANGE = 'hookline.deliveries';
export const DELIVERIES_READY_QUEUE = 'deliveries.ready';
export const DELIVERIES_READY_ROUTING_KEY = 'delivery.ready';
export const DELIVERIES_DLQ_QUEUE = 'deliveries.dlq';
export const DELIVERIES_DEAD_ROUTING_KEY = 'delivery.dead';

const DLQ_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function connectBroker(url: string): Broker {
  return amqp.connect([url]);
}

export function waitRoutingKey({ label }: RetryDelay): string {
  return `delivery.wait.${label}`;
}

export function waitQueueName({ label }: RetryDelay): string {
  return `deliveries.wait.${label}`;
}

export async function declareTopology(channel: ConfirmChannel): Promise<void> {
  await channel.assertExchange(DELIVERIES_EXCHANGE, 'direct', {
    durable: true,
  });
  await channel.assertQueue(DELIVERIES_READY_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      // Quorum queues drop a message after 20 returns by default, which a
      // database outage could reach.
      'x-delivery-limit': -1,
    },
  });
  await channel.bindQueue(
    DELIVERIES_READY_QUEUE,
    DELIVERIES_EXCHANGE,
    DELIVERIES_READY_ROUTING_KEY,
  );
  await channel.assertQueue(DELIVERIES_DLQ_QUEUE, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum', 'x-message-ttl': DLQ_TTL_MS },
  });
  await channel.bindQueue(
    DELIVERIES_DLQ_QUEUE,
    DELIVERIES_EXCHANGE,
    DELIVERIES_DEAD_ROUTING_KEY,
  );
}

// Each delay has its own queue, so a long wait never holds back a shorter one.
// Expired messages return to the ready queue through dead-lettering, whose
// default strategy could lose them on the way.
export async function declareWaitQueues(
  channel: ConfirmChannel,
  delays: RetryDelay[],
): Promise<void> {
  for (const delay of delays) {
    const queue = waitQueueName(delay);
    await channel.assertQueue(queue, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-message-ttl': delay.ms,
        'x-dead-letter-exchange': DELIVERIES_EXCHANGE,
        'x-dead-letter-routing-key': DELIVERIES_READY_ROUTING_KEY,
        'x-dead-letter-strategy': 'at-least-once',
        'x-overflow': 'reject-publish',
      },
    });
    await channel.bindQueue(queue, DELIVERIES_EXCHANGE, waitRoutingKey(delay));
  }
}
