import {
  Type,
  type FastifyPluginAsyncTypebox,
} from '@fastify/type-provider-typebox';
import {
  assertPublicTarget,
  BlockedTargetError,
  encryptSecret,
  generateEndpointSecret,
  newId,
  type Pool,
  type ResolveHost,
  type TargetPolicy,
} from '@hookline/shared';
import { notFound, ProblemError } from '../errors.js';
import { PaginationQuery, toPage } from '../pagination.js';

const PUBLIC_COLUMNS = 'id, url, event_types, status, created_at, updated_at';

const WebhookUrl = Type.String({ format: 'uri', maxLength: 2048 });
const EventTypes = Type.Array(Type.String({ minLength: 1, maxLength: 255 }), {
  minItems: 1,
  maxItems: 100,
});
const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

export const endpointRoutes: FastifyPluginAsyncTypebox<{
  pool: Pool;
  encryptionKey: Buffer;
  targetPolicy: TargetPolicy;
  resolveHost?: ResolveHost;
}> = async (app, { pool, encryptionKey, targetPolicy, resolveHost }) => {
  // Rejecting internal URLs here gives a clear error early. The worker checks
  // again on every connection, since DNS answers can change.
  async function assertWebhookUrl(url: string): Promise<void> {
    try {
      await assertPublicTarget(url, targetPolicy, resolveHost);
    } catch (error) {
      if (error instanceof BlockedTargetError) {
        throw new ProblemError(400, 'Bad Request', error.message);
      }
      throw error;
    }
  }

  app.post(
    '/endpoints',
    {
      schema: {
        tags: ['endpoints'],
        body: Type.Object({ url: WebhookUrl, event_types: EventTypes }),
      },
    },
    async (request, reply) => {
      const { url, event_types: eventTypes } = request.body;
      await assertWebhookUrl(url);

      // The secret is only returned here; it cannot be read back later.
      const secret = generateEndpointSecret();
      const { rows } = await pool.query(
        `INSERT INTO endpoints (id, project_id, url, secret_encrypted, event_types)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${PUBLIC_COLUMNS}`,
        [
          newId(),
          request.projectId,
          url,
          encryptSecret(secret, encryptionKey),
          eventTypes,
        ],
      );
      return reply.code(201).send({ ...rows[0], secret });
    },
  );

  app.get(
    '/endpoints',
    { schema: { tags: ['endpoints'], querystring: PaginationQuery } },
    async (request) => {
      const { limit, cursor } = request.query;
      const { rows } = await pool.query(
        `SELECT ${PUBLIC_COLUMNS} FROM endpoints
         WHERE project_id = $1 AND status <> 'deleted'
           AND ($2::uuid IS NULL OR id < $2)
         ORDER BY id DESC
         LIMIT $3`,
        [request.projectId, cursor ?? null, limit + 1],
      );
      return toPage(rows, limit);
    },
  );

  app.get(
    '/endpoints/:id',
    { schema: { tags: ['endpoints'], params: IdParams } },
    async (request) => {
      const { rows } = await pool.query(
        `SELECT ${PUBLIC_COLUMNS} FROM endpoints
         WHERE id = $1 AND project_id = $2 AND status <> 'deleted'`,
        [request.params.id, request.projectId],
      );
      if (!rows[0]) {
        throw notFound('Endpoint');
      }
      return rows[0];
    },
  );

  app.patch(
    '/endpoints/:id',
    {
      schema: {
        tags: ['endpoints'],
        params: IdParams,
        body: Type.Object({
          url: Type.Optional(WebhookUrl),
          event_types: Type.Optional(EventTypes),
          status: Type.Optional(
            Type.Union([Type.Literal('active'), Type.Literal('disabled')]),
          ),
        }),
      },
    },
    async (request) => {
      const { url, event_types: eventTypes, status } = request.body;
      if (url) {
        await assertWebhookUrl(url);
      }

      const { rows } = await pool.query(
        `UPDATE endpoints
         SET url = COALESCE($3, url),
             event_types = COALESCE($4, event_types),
             status = COALESCE($5, status),
             updated_at = now()
         WHERE id = $1 AND project_id = $2 AND status <> 'deleted'
         RETURNING ${PUBLIC_COLUMNS}`,
        [
          request.params.id,
          request.projectId,
          url ?? null,
          eventTypes ?? null,
          status ?? null,
        ],
      );
      if (!rows[0]) {
        throw notFound('Endpoint');
      }
      return rows[0];
    },
  );

  // Webhooks are signed with both secrets during the overlap, so the receiver
  // can switch to the new one without rejecting anything. Another rotation
  // within the overlap ends the older secret at once.
  app.post(
    '/endpoints/:id/rotate-secret',
    { schema: { tags: ['endpoints'], params: IdParams } },
    async (request) => {
      const secret = generateEndpointSecret();
      const { rows } = await pool.query(
        `UPDATE endpoints
         SET previous_secret_encrypted = secret_encrypted,
             previous_secret_expires_at = now() + interval '24 hours',
             secret_encrypted = $3,
             updated_at = now()
         WHERE id = $1 AND project_id = $2 AND status <> 'deleted'
         RETURNING ${PUBLIC_COLUMNS}, previous_secret_expires_at`,
        [
          request.params.id,
          request.projectId,
          encryptSecret(secret, encryptionKey),
        ],
      );
      if (!rows[0]) {
        throw notFound('Endpoint');
      }
      return { ...rows[0], secret };
    },
  );

  // Soft delete, so the delivery history keeps pointing at a real endpoint.
  app.delete(
    '/endpoints/:id',
    { schema: { tags: ['endpoints'], params: IdParams } },
    async (request, reply) => {
      const { rowCount } = await pool.query(
        `UPDATE endpoints SET status = 'deleted', updated_at = now()
         WHERE id = $1 AND project_id = $2 AND status <> 'deleted'`,
        [request.params.id, request.projectId],
      );
      if (!rowCount) {
        throw notFound('Endpoint');
      }
      return reply.code(204).send();
    },
  );
};
