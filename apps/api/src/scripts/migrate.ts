import { requireEnv, runMigrations } from '@hookline/shared';

await runMigrations(requireEnv('DATABASE_URL'));
console.log('Migrations applied');
