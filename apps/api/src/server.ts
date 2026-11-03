import {
  createPool,
  onShutdown,
  parseEncryptionKey,
  requireEnv,
} from '@hookline/shared';
import { buildApp } from './app.js';

const pool = createPool(requireEnv('DATABASE_URL'));
const app = await buildApp({
  pool,
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

// Fastify stops accepting connections and answers the requests in progress
// before closing, so an accepted event is never cut off mid-transaction.
onShutdown(app.log, async () => {
  await app.close();
  await pool.end();
});
