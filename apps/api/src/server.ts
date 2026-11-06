import {
  createPool,
  createRegistry,
  onShutdown,
  parseEncryptionKey,
  requireEnv,
  startOpsServer,
} from '@hookline/shared';
import { buildApp } from './app.js';

const pool = createPool(requireEnv('DATABASE_URL'));
const registry = createRegistry('api');
const app = await buildApp({
  pool,
  registry,
  encryptionKey: parseEncryptionKey(requireEnv('ENCRYPTION_KEY')),
  logger: true,
  allowPrivateTargets: process.env.ALLOW_PRIVATE_TARGETS === 'true',
  ...(process.env.RATE_LIMIT_PER_MINUTE && {
    rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE),
  }),
});

await app.listen({
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3000),
});

// Metrics and health checks on a port of their own, never published.
const ops = await startOpsServer({
  registry,
  port: Number(process.env.METRICS_PORT ?? 9464),
  ...(process.env.METRICS_HOST && { host: process.env.METRICS_HOST }),
  isReady: async () => {
    await pool.query('SELECT 1');
    return true;
  },
});

// Fastify stops accepting connections and answers the requests in progress
// before closing, so an accepted event is never cut off mid-transaction.
onShutdown(app.log, async () => {
  await app.close();
  await pool.end();
  await ops.close();
});
