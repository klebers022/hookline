import { requireEnv } from '@hookline/shared';
import { runMigrations } from '../migrate.js';

await runMigrations(
  requireEnv('DATABASE_URL'),
  ...(process.env.MIGRATIONS_DIR ? [process.env.MIGRATIONS_DIR] : []),
);
console.log('Migrations applied');
