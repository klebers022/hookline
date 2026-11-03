import {
  connectBroker,
  createPool,
  onShutdown,
  requireEnv,
} from '@hookline/shared';
import { pino } from 'pino';
import { startRelay } from './relay.js';

const logger = pino({ name: 'relay' });
const pool = createPool(requireEnv('DATABASE_URL'));
const broker = connectBroker(requireEnv('RABBITMQ_URL'));

const relay = startRelay({ pool, broker, logger });
logger.info('Relay started');

// The relay finishes the batch it is publishing, so the rows it published
// are marked before the database connection closes.
onShutdown(logger, async () => {
  await relay.stop();
  await broker.close();
  await pool.end();
});
