import { runner } from 'node-pg-migrate';
import { fileURLToPath } from 'node:url';

// The repository's migrations, found from this file in src/ and dist/ alike.
// A container image keeps them elsewhere and passes its own directory.
const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../db/migrations', import.meta.url),
);

export async function runMigrations(
  databaseUrl: string,
  dir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<void> {
  await runner({
    databaseUrl,
    dir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  });
}
