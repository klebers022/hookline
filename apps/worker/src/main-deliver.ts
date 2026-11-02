import {
  connectBroker,
  createPool,
  parseEncryptionKey,
  requireEnv,
} from '@hookline/shared';
import { pino } from 'pino';
import { startDeliveryWorker } from './deliver.js';

const logger = pino({ name: 'delivery-worker' });

startDeliveryWorker({
  pool: createPool(requireEnv('DATABASE_URL')),
  broker: connectBroker(requireEnv('RABBITMQ_URL')),
  encryptionKey: parseEncryptionKey(requireEnv('ENCRYPTION_KEY')),
  logger,
});
logger.info('Delivery worker started');
