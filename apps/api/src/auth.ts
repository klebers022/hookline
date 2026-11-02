import { hashApiKey, type Pool } from '@hookline/shared';
import type { FastifyRequest } from 'fastify';
import { ProblemError } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    projectId: string;
  }
}

export function createAuthHook(pool: Pool) {
  return async function authenticate(request: FastifyRequest): Promise<void> {
    const [scheme, key] = (request.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !key) {
      throw new ProblemError(401, 'Unauthorized', 'Missing API key');
    }

    const { rows } = await pool.query<{ project_id: string }>(
      `SELECT project_id FROM api_keys
       WHERE key_hash = $1 AND revoked_at IS NULL`,
      [hashApiKey(key)],
    );
    const row = rows[0];
    if (!row) {
      throw new ProblemError(401, 'Unauthorized', 'Invalid API key');
    }
    request.projectId = row.project_id;
  };
}
