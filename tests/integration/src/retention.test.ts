import { createProject, runMigrations, runRetention } from '@hookline/api';
import { createPool, newId, type Pool } from '@hookline/shared';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

type Status = 'pending' | 'retrying' | 'succeeded' | 'dead';

describe('retention', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = createPool(container.getConnectionUri());
    ({ projectId } = await createProject(pool, 'retention'));
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM events');
  });

  async function event(ageDays: number): Promise<string> {
    const id = newId();
    await pool.query(
      `INSERT INTO events (id, project_id, type, payload, created_at)
       VALUES ($1, $2, 'test', '{}', now() - make_interval(days => $3))`,
      [id, projectId, ageDays],
    );
    return id;
  }

  // A delivery with one attempt, and an outbox row published `publishedDays`
  // ago, or not yet published when null.
  async function delivery(
    eventId: string,
    status: Status,
    publishedDays: number | null = 40,
  ): Promise<string> {
    const id = newId();
    // Each delivery needs an endpoint of its own: (event, endpoint) is unique.
    const endpoint = newId();
    await pool.query(
      `INSERT INTO endpoints (id, project_id, url, secret_encrypted, event_types)
       VALUES ($1, $2, 'https://example.com/hook', 'unused', '{test}')`,
      [endpoint, projectId],
    );
    await pool.query(
      `INSERT INTO deliveries (id, event_id, endpoint_id, status, attempt_count)
       VALUES ($1, $2, $3, $4, 1)`,
      [id, eventId, endpoint, status],
    );
    await pool.query(
      `INSERT INTO delivery_attempts
         (id, delivery_id, attempt_number, started_at, duration_ms, response_status)
       VALUES ($1, $2, 1, now(), 10, 200)`,
      [newId(), id],
    );
    await pool.query(
      `INSERT INTO outbox (delivery_id, routing_key, payload, published_at)
       VALUES ($1, 'delivery.ready', '{}',
         CASE WHEN $2::int IS NULL THEN NULL
              ELSE now() - make_interval(days => $2::int) END)`,
      [id, publishedDays],
    );
    return id;
  }

  async function exists(table: string, id: string): Promise<boolean> {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM ${table} WHERE id = $1`,
      [id],
    );
    return rowCount === 1;
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(sql, params);
    return Number(rows[0]!.count);
  }

  it('deletes old events whose deliveries all ended, with their history', async () => {
    const finished = await event(31);
    const succeeded = await delivery(finished, 'succeeded');
    const dead = await delivery(finished, 'dead');
    const noSubscribers = await event(31);

    const result = await runRetention(pool);

    expect(result.events).toBe(2);
    expect(await exists('events', finished)).toBe(false);
    expect(await exists('events', noSubscribers)).toBe(false);
    for (const id of [succeeded, dead]) {
      expect(await exists('deliveries', id)).toBe(false);
      expect(
        await count(
          'SELECT count(*) FROM delivery_attempts WHERE delivery_id = $1',
          [id],
        ),
      ).toBe(0);
      expect(
        await count('SELECT count(*) FROM outbox WHERE delivery_id = $1', [id]),
      ).toBe(0);
    }
  });

  it('keeps events still in progress or too recent', async () => {
    const retrying = await event(31);
    await delivery(retrying, 'succeeded');
    await delivery(retrying, 'retrying');
    const pending = await event(31);
    await delivery(pending, 'pending');
    // Dead, but its last message has not reached the DLQ yet.
    const unpublished = await event(31);
    await delivery(unpublished, 'dead', null);
    const recent = await event(29);
    await delivery(recent, 'succeeded');

    const result = await runRetention(pool);

    expect(result.events).toBe(0);
    for (const id of [retrying, pending, unpublished, recent]) {
      expect(await exists('events', id)).toBe(true);
    }
  });

  it('deletes outbox rows published over a week ago, and only those', async () => {
    const eventId = await event(1);
    const old = await delivery(eventId, 'succeeded', 8);
    const recent = await delivery(eventId, 'succeeded', 6);
    const unpublished = await delivery(eventId, 'retrying', null);

    const result = await runRetention(pool);

    expect(result.outboxRows).toBe(1);
    const left = async (id: string) =>
      count('SELECT count(*) FROM outbox WHERE delivery_id = $1', [id]);
    expect(await left(old)).toBe(0);
    expect(await left(recent)).toBe(1);
    expect(await left(unpublished)).toBe(1);
    // The delivery itself stays: only its outbox row was history.
    expect(await exists('deliveries', old)).toBe(true);
  });

  it('works through more rows than one batch', async () => {
    for (let i = 0; i < 5; i++) {
      await delivery(await event(40), 'succeeded');
    }

    const result = await runRetention(pool, { batchSize: 2 });

    expect(result.events).toBe(5);
    expect(await count('SELECT count(*) FROM events')).toBe(0);
  });

  it('follows the configured ages', async () => {
    const eventId = await event(3);
    await delivery(eventId, 'succeeded', 3);

    expect(await runRetention(pool)).toEqual({ events: 0, outboxRows: 0 });
    expect(await runRetention(pool, { eventDays: 2, outboxDays: 2 })).toEqual({
      events: 1,
      outboxRows: 0,
    });
  });
});
