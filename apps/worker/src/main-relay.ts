import { connectBroker, createPool, requireEnv } from '@hookline/shared';
import { pino } from 'pino';
import { startRelay } from './relay.js';

const logger = pino({ name: 'relay' });

startRelay({
  pool: createPool(requireEnv('DATABASE_URL')),
  broker: connectBroker(requireEnv('RABBITMQ_URL')),
  logger,
});
logger.info('Relay started');
