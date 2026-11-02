import {
  Type,
  type FastifyPluginAsyncTypebox,
} from '@fastify/type-provider-typebox';
import type { Pool } from '@hookline/shared';
import { notFound } from '../errors.js';
import { PaginationQuery, toPage } from '../pagination.js';

const DeliveryStatus = Type.Union([
  Type.Literal('pending'),
  Type.Literal('retrying'),
  Type.Literal('succeeded'),
  Type.Literal('dead'),
]);

const DELIVERY_COLUMNS = `d.id, d.event_id, d.endpoint_id, d.status,
  d.attempt_count, d.delivered_at, d.created_at`;

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
};
