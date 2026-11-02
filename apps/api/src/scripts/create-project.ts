import { createPool, requireEnv } from '@hookline/shared';
import { createProject } from '../projects.js';

const name = process.argv[2];
if (!name) {
  console.error('Usage: pnpm project:create <name>');
  process.exit(1);
}

const pool = createPool(requireEnv('DATABASE_URL'));
const { projectId, apiKey } = await createProject(pool, name);
await pool.end();

console.log(`Project: ${projectId}`);
console.log(`API key (shown only once): ${apiKey}`);
