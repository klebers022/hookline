import {
  Type,
  type FastifyPluginAsyncTypebox,
} from '@fastify/type-provider-typebox';
import {
  DELIVERIES_READY_ROUTING_KEY,
  newId,
  withTransaction,
  type Pool,
  type PoolClient,
} from '@hookline/shared';
import type { ApiMetrics } from '../app.js';
import { notFound, ProblemError } from '../errors.js';
import { PaginationQuery, toPage } from '../pagination.js';

async function createDeliveries(
  client: PoolClient,
  projectId: string,
  eventId: string,
  type: string,
): Promise<number> {
  const { rows: endpoints } = await client.query<{ id: string }>(
    `SELECT id FROM endpoints
     WHERE project_id = $1 AND status = 'active'
       AND event_types @> ARRAY[$2]::text[]`,
    [projectId, type],
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
}

export const eventRoutes: FastifyPluginAsyncTypebox<{
  pool: Pool;
  metrics: ApiMetrics;
}> = async (app, { pool, metrics }) => {
  app.post(
    '/events',
    {
      schema: {
        tags: ['events'],
        headers: Type.Object({
          'idempotency-key': Type.Optional(
            Type.String({ minLength: 1, maxLength: 255 }),
          ),
        }),
        body: Type.Object({
          type: Type.String({ minLength: 1, maxLength: 255 }),
          payload: Type.Record(Type.String(), Type.Unknown()),
        }),
      },
    },
    async (request, reply) => {
      const { type, payload } = request.body;
      const serializedPayload = JSON.stringify(payload);
      const idempotencyKey = request.headers['idempotency-key'] ?? null;
      const eventId = newId();

      // The event, its deliveries and their outbox rows commit together, so
      // an accepted event can never be left without a pending publication.
      const accepted = await withTransaction(pool, async (client) => {
        // A concurrent request with the same key waits here for the first to
        // commit, so it can read the original event below.
        const { rowCount } = await client.query(
          `INSERT INTO events (id, project_id, type, payload, idempotency_key)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (project_id, idempotency_key)
             WHERE idempotency_key IS NOT NULL
             DO NOTHING`,
          [eventId, request.projectId, type, serializedPayload, idempotencyKey],
        );
        if (rowCount) {
          const deliveries = await createDeliveries(
            client,
            request.projectId,
            eventId,
            type,
          );
          return { id: eventId, deliveries, replayed: false };
        }

        const { rows } = await client.query<{
          id: string;
          same_request: boolean;
          deliveries: number;
        }>(
          `SELECT e.id, e.type = $3 AND e.payload = $4::jsonb AS same_request,
                  (SELECT count(*)::int FROM deliveries d
                   WHERE d.event_id = e.id) AS deliveries
           FROM events e
           WHERE e.project_id = $1 AND e.idempotency_key = $2`,
          [request.projectId, idempotencyKey, type, serializedPayload],
        );
        const original = rows[0];
        if (!original?.same_request) {
          throw new ProblemError(
            409,
            'Conflict',
            'This Idempotency-Key was already used with a different event',
          );
        }
        return {
          id: original.id,
          deliveries: original.deliveries,
          replayed: true,
        };
      });

      if (accepted.replayed) {
        reply.header('idempotent-replayed', 'true');
      } else {
        metrics.eventsAccepted.inc();
        metrics.deliveriesCreated.inc(accepted.deliveries);
      }
      return reply
        .code(202)
        .send({ id: accepted.id, type, deliveries: accepted.deliveries });
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
