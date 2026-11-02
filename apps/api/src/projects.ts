import {
  generateApiKey,
  newId,
  withTransaction,
  type Pool,
} from '@hookline/shared';

export interface CreatedProject {
  projectId: string;
  apiKey: string;
}

export async function createProject(
  pool: Pool,
  name: string,
): Promise<CreatedProject> {
  const projectId = newId();
  const { key, prefix, hash } = generateApiKey();

  await withTransaction(pool, async (client) => {
    await client.query('INSERT INTO projects (id, name) VALUES ($1, $2)', [
      projectId,
      name,
    ]);
    await client.query(
      `INSERT INTO api_keys (id, project_id, key_hash, prefix)
       VALUES ($1, $2, $3, $4)`,
      [newId(), projectId, hash, prefix],
    );
  });

  return { projectId, apiKey: key };
}
