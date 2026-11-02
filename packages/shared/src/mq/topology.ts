import amqp, { type AmqpConnectionManager } from 'amqp-connection-manager';
import type { ConfirmChannel } from 'amqplib';

export type Broker = AmqpConnectionManager;

export const DELIVERIES_EXCHANGE = 'hookline.deliveries';
export const DELIVERIES_READY_QUEUE = 'deliveries.ready';
export const DELIVERIES_READY_ROUTING_KEY = 'delivery.ready';

export function connectBroker(url: string): Broker {
  return amqp.connect([url]);
}

export async function declareTopology(channel: ConfirmChannel): Promise<void> {
  await channel.assertExchange(DELIVERIES_EXCHANGE, 'direct', {
    durable: true,
  });
  await channel.assertQueue(DELIVERIES_READY_QUEUE, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  await channel.bindQueue(
    DELIVERIES_READY_QUEUE,
    DELIVERIES_EXCHANGE,
    DELIVERIES_READY_ROUTING_KEY,
  );
}
