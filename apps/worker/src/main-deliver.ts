import {
  connectBroker,
  createPool,
  createRegistry,
  onShutdown,
  parseEncryptionKey,
  parseRetryDelays,
  requireEnv,
  startOpsServer,
} from '@hookline/shared';
import { pino } from 'pino';
import { startDeliveryWorker } from './deliver.js';

const logger = pino({ name: 'delivery-worker' });
const pool = createPool(requireEnv('DATABASE_URL'), (error) =>
  logger.warn({ err: error }, 'Database connection lost'),
);
const broker = connectBroker(requireEnv('RABBITMQ_URL'));
const registry = createRegistry('deliver');

const worker = startDeliveryWorker({
  pool,
  broker,
  encryptionKey: parseEncryptionKey(requireEnv('ENCRYPTION_KEY')),
  retryDelays: parseRetryDelays(process.env.RETRY_DELAYS),
  allowPrivateTargets: process.env.ALLOW_PRIVATE_TARGETS === 'true',
  ...(process.env.ENDPOINT_RATE_LIMIT_PER_SECOND && {
    endpointRateLimitPerSecond: Number(
      process.env.ENDPOINT_RATE_LIMIT_PER_SECOND,
    ),
  }),
  logger,
  registry,
});
// Metrics and health checks on a port of their own, never published.
const ops = await startOpsServer({
  registry,
  port: Number(process.env.METRICS_PORT ?? 9466),
  ...(process.env.METRICS_HOST && { host: process.env.METRICS_HOST }),
  isReady: () => broker.isConnected(),
});
logger.info('Delivery worker started');

onShutdown(logger, async () => {
  await worker.stop();
  await broker.close();
  await pool.end();
  await ops.close();
});
