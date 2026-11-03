import { requireEnv, runMigrations } from '@hookline/shared';

await runMigrations(
  requireEnv('DATABASE_URL'),
  ...(process.env.MIGRATIONS_DIR ? [process.env.MIGRATIONS_DIR] : []),
);
console.log('Migrations applied');
