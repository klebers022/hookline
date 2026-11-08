import type { Pool } from '@hookline/shared';

export interface RetentionOptions {
  /** Published outbox rows older than this are deleted. */
  outboxDays?: number;
  /** Events older than this are deleted once all their deliveries ended. */
  eventDays?: number;
  /** Rows deleted per statement. */
  batchSize?: number;
}

export interface RetentionResult {
  events: number;
  outboxRows: number;
}

// An event goes only when every delivery it made has ended (succeeded or
// dead) and has nothing left in the outbox: retention never removes work in
// progress. Its deliveries, attempts and outbox rows go with it, through
// ON DELETE CASCADE. SKIP LOCKED leaves rows another process holds for the
// next run.
const DELETE_EVENTS = `
  DELETE FROM events WHERE id IN (
    SELECT e.id FROM events e
    WHERE e.created_at < now() - make_interval(days => $1)
      AND NOT EXISTS (
        SELECT 1 FROM deliveries d
        WHERE d.event_id = e.id
          AND (
            d.status NOT IN ('succeeded', 'dead')
            OR EXISTS (
              SELECT 1 FROM outbox o
              WHERE o.delivery_id = d.id AND o.published_at IS NULL
            )
          )
      )
    LIMIT $2
    FOR UPDATE OF e SKIP LOCKED
  )`;

// Once published, an outbox row is only history: the relay never reads it
// again.
const DELETE_OUTBOX = `
  DELETE FROM outbox WHERE id IN (
    SELECT id FROM outbox
    WHERE published_at < now() - make_interval(days => $1)
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  )`;

// Deletes in batches, each its own short transaction, so a large backlog
// never holds locks for long or builds one huge transaction.
async function deleteInBatches(
  pool: Pool,
  sql: string,
  days: number,
  batchSize: number,
): Promise<number> {
  let total = 0;
  for (;;) {
    const { rowCount } = await pool.query(sql, [days, batchSize]);
    total += rowCount ?? 0;
    if ((rowCount ?? 0) < batchSize) {
      return total;
    }
  }
}

export async function runRetention(
  pool: Pool,
  { outboxDays = 7, eventDays = 30, batchSize = 1000 }: RetentionOptions = {},
): Promise<RetentionResult> {
  const events = await deleteInBatches(
    pool,
    DELETE_EVENTS,
    eventDays,
    batchSize,
  );
  const outboxRows = await deleteInBatches(
    pool,
    DELETE_OUTBOX,
    outboxDays,
    batchSize,
  );
  return { events, outboxRows };
}
