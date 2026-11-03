import {
  connectBroker,
  createPool,
  parseEncryptionKey,
  parseRetryDelays,
  requireEnv,
} from '@hookline/shared';
import { pino } from 'pino';
import { startDeliveryWorker } from './deliver.js';

const logger = pino({ name: 'delivery-worker' });

startDeliveryWorker({
  pool: createPool(requireEnv('DATABASE_URL')),
  broker: connectBroker(requireEnv('RABBITMQ_URL')),
  encryptionKey: parseEncryptionKey(requireEnv('ENCRYPTION_KEY')),
  retryDelays: parseRetryDelays(process.env.RETRY_DELAYS),
  allowPrivateTargets: process.env.ALLOW_PRIVATE_TARGETS === 'true',
  ...(process.env.ENDPOINT_RATE_LIMIT_PER_SECOND && {
    endpointRateLimitPerSecond: Number(
      process.env.ENDPOINT_RATE_LIMIT_PER_SECOND,
    ),
  }),
  logger,
});
logger.info('Delivery worker started');
