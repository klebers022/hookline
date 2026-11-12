import {
  connectBroker,
  createPool,
  createRegistry,
  onShutdown,
  requireEnv,
  startOpsServer,
} from '@hookline/shared';
import { pino } from 'pino';
import { startRelay } from './relay.js';

const logger = pino({ name: 'relay' });
const pool = createPool(requireEnv('DATABASE_URL'), (error) =>
  logger.warn({ err: error }, 'Database connection lost'),
);
const broker = connectBroker(requireEnv('RABBITMQ_URL'));

const registry = createRegistry('relay');

const relay = startRelay({ pool, broker, logger, registry });
// Metrics and health checks on a port of their own, never published.
const ops = await startOpsServer({
  registry,
  port: Number(process.env.METRICS_PORT ?? 9465),
  ...(process.env.METRICS_HOST && { host: process.env.METRICS_HOST }),
  isReady: () => broker.isConnected(),
});
logger.info('Relay started');

// The relay finishes the batch it is publishing, so the rows it published
// are marked before the database connection closes.
onShutdown(logger, async () => {
  await relay.stop();
  await broker.close();
  await pool.end();
  await ops.close();
});
