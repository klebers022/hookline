import { Type } from '@fastify/type-provider-typebox';

export const PaginationQuery = Type.Object({
  limit: Type.Integer({ minimum: 1, maximum: 100, default: 50 }),
  cursor: Type.Optional(Type.String({ format: 'uuid' })),
});

export function toPage<T extends { id: string }>(rows: T[], limit: number) {
  const data = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return {
    data,
    next_cursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
  };
}
