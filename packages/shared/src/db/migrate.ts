import { runner } from 'node-pg-migrate';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../../db/migrations', import.meta.url),
);

export async function runMigrations(databaseUrl: string): Promise<void> {
  await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  });
}
