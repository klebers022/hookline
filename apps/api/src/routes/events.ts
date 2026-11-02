import {
  Type,
  type FastifyPluginAsyncTypebox,
} from '@fastify/type-provider-typebox';
import {
  DELIVERIES_READY_ROUTING_KEY,
  newId,
  withTransaction,
  type Pool,
} from '@hookline/shared';
import { notFound } from '../errors.js';
import { PaginationQuery, toPage } from '../pagination.js';

export const eventRoutes: FastifyPluginAsyncTypebox<{ pool: Pool }> = async (
  app,
  { pool },
) => {
  app.post(
    '/events',
    {
      schema: {
        tags: ['events'],
        body: Type.Object({
          type: Type.String({ minLength: 1, maxLength: 255 }),
          payload: Type.Record(Type.String(), Type.Unknown()),
        }),
      },
    },
    async (request, reply) => {
      const { type, payload } = request.body;
      const eventId = newId();

      // The event, its deliveries and their outbox rows commit together, so
      // an accepted event can never be left without a pending publication.
      const deliveries = await withTransaction(pool, async (client) => {
        await client.query(
          `INSERT INTO events (id, project_id, type, payload)
           VALUES ($1, $2, $3, $4)`,
          [eventId, request.projectId, type, JSON.stringify(payload)],
        );

        const { rows: endpoints } = await client.query<{ id: string }>(
          `SELECT id FROM endpoints
           WHERE project_id = $1 AND status = 'active'
             AND event_types @> ARRAY[$2]::text[]`,
          [request.projectId, type],
        );
        if (endpoints.length === 0) {
          return 0;
        }

        const deliveryIds = endpoints.map(() => newId());
        await client.query(
          `INSERT INTO deliveries (id, event_id, endpoint_id)
           SELECT unnest($1::uuid[]), $2, unnest($3::uuid[])`,
          [deliveryIds, eventId, endpoints.map((endpoint) => endpoint.id)],
        );
        await client.query(
          `INSERT INTO outbox (delivery_id, routing_key, payload)
           SELECT id, $2, jsonb_build_object('delivery_id', id, 'attempt', 1)
           FROM unnest($1::uuid[]) AS id`,
          [deliveryIds, DELIVERIES_READY_ROUTING_KEY],
        );
        return deliveryIds.length;
      });

      return reply.code(202).send({ id: eventId, type, deliveries });
    },
  );

  app.get(
    '/events',
    { schema: { tags: ['events'], querystring: PaginationQuery } },
    async (request) => {
      const { limit, cursor } = request.query;
      const { rows } = await pool.query(
        `SELECT id, type, payload, created_at FROM events
         WHERE project_id = $1 AND ($2::uuid IS NULL OR id < $2)
         ORDER BY id DESC
         LIMIT $3`,
        [request.projectId, cursor ?? null, limit + 1],
      );
      return toPage(rows, limit);
    },
  );

  app.get(
    '/events/:id',
    {
      schema: {
        tags: ['events'],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      },
    },
    async (request) => {
      const { rows } = await pool.query(
        `SELECT id, type, payload, created_at FROM events
         WHERE id = $1 AND project_id = $2`,
        [request.params.id, request.projectId],
      );
      if (!rows[0]) {
        throw notFound('Event');
      }

      const { rows: deliveries } = await pool.query(
        `SELECT id, endpoint_id, status, attempt_count, next_attempt_at,
                delivered_at, created_at
         FROM deliveries WHERE event_id = $1
         ORDER BY id`,
        [request.params.id],
      );
      return { ...rows[0], deliveries };
    },
  );
};
