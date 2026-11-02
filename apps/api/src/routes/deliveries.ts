import {
  Type,
  type FastifyPluginAsyncTypebox,
} from '@fastify/type-provider-typebox';
import {
  DELIVERIES_READY_ROUTING_KEY,
  withTransaction,
  type Pool,
} from '@hookline/shared';
import { notFound, ProblemError } from '../errors.js';
import { PaginationQuery, toPage } from '../pagination.js';

const DeliveryStatus = Type.Union([
  Type.Literal('pending'),
  Type.Literal('retrying'),
  Type.Literal('succeeded'),
  Type.Literal('dead'),
]);

const DELIVERY_COLUMNS = `d.id, d.event_id, d.endpoint_id, d.status,
  d.attempt_count, d.next_attempt_at, d.delivered_at, d.created_at`;

export const deliveryRoutes: FastifyPluginAsyncTypebox<{ pool: Pool }> = async (
  app,
  { pool },
) => {
  app.get(
    '/deliveries',
    {
      schema: {
        tags: ['deliveries'],
        querystring: Type.Intersect([
          PaginationQuery,
          Type.Object({ status: Type.Optional(DeliveryStatus) }),
        ]),
      },
    },
    async (request) => {
      const { limit, cursor, status } = request.query;
      const { rows } = await pool.query(
        `SELECT ${DELIVERY_COLUMNS} FROM deliveries d
         JOIN endpoints e ON e.id = d.endpoint_id
         WHERE e.project_id = $1
           AND ($2::uuid IS NULL OR d.id < $2)
           AND ($3::text IS NULL OR d.status = $3)
         ORDER BY d.id DESC
         LIMIT $4`,
        [request.projectId, cursor ?? null, status ?? null, limit + 1],
      );
      return toPage(rows, limit);
    },
  );

  app.get(
    '/deliveries/:id',
    {
      schema: {
        tags: ['deliveries'],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      },
    },
    async (request) => {
      const { rows } = await pool.query(
        `SELECT ${DELIVERY_COLUMNS} FROM deliveries d
         JOIN endpoints e ON e.id = d.endpoint_id
         WHERE d.id = $1 AND e.project_id = $2`,
        [request.params.id, request.projectId],
      );
      if (!rows[0]) {
        throw notFound('Delivery');
      }

      const { rows: attempts } = await pool.query(
        `SELECT attempt_number, started_at, duration_ms, response_status,
                error_code, response_snippet
         FROM delivery_attempts WHERE delivery_id = $1
         ORDER BY attempt_number`,
        [request.params.id],
      );
      return { ...rows[0], attempts };
    },
  );

  app.post(
    '/deliveries/:id/retry',
    {
      schema: {
        tags: ['deliveries'],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const attempt = await withTransaction(pool, async (client) => {
        // The row lock makes concurrent retries of one delivery queue only once.
        const { rows } = await client.query<{
          status: string;
          attempt_count: number;
          endpoint_status: string;
        }>(
          `SELECT d.status, d.attempt_count, e.status AS endpoint_status
           FROM deliveries d
           JOIN endpoints e ON e.id = d.endpoint_id
           WHERE d.id = $1 AND e.project_id = $2
           FOR UPDATE OF d`,
          [id, request.projectId],
        );
        const delivery = rows[0];
        if (!delivery) {
          throw notFound('Delivery');
        }
        if (delivery.status !== 'dead') {
          throw new ProblemError(
            409,
            'Conflict',
            'Only a dead delivery can be retried',
          );
        }
        if (delivery.endpoint_status !== 'active') {
          throw new ProblemError(
            409,
            'Conflict',
            'The endpoint must be active to retry a delivery',
          );
        }

        const nextAttempt = delivery.attempt_count + 1;
        await client.query(
          `UPDATE deliveries SET status = 'pending' WHERE id = $1`,
          [id],
        );
        await client.query(
          `INSERT INTO outbox (delivery_id, routing_key, payload)
           VALUES ($1, $2, jsonb_build_object('delivery_id', $1::uuid, 'attempt', $3::int))`,
          [id, DELIVERIES_READY_ROUTING_KEY, nextAttempt],
        );
        return nextAttempt;
      });

      return reply.code(202).send({ id, status: 'pending', attempt });
    },
  );
};
