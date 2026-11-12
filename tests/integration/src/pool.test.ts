import { createPool, withTransaction, type Pool } from '@hookline/shared';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// What a database restart does to every open connection: Postgres ends the
// session with 57P01 (admin_shutdown). An 'error' event nobody listens to
// would end the process; the chaos test saw the API and the relay crash so.
describe('database pool', () => {
  let postgres: StartedPostgreSqlContainer;
  let admin: Pool;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:17-alpine').start();
    admin = createPool(postgres.getConnectionUri());
  });

  afterAll(async () => {
    await admin?.end();
    await postgres?.stop();
  });

  async function terminateOthers(): Promise<void> {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE pid <> pg_backend_pid() AND datname = current_database()`,
    );
  }

  async function pidOf(pool: Pool): Promise<number> {
    const { rows } = await pool.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );
    return rows[0]!.pid;
  }

  it('survives losing an idle connection and opens a new one', async () => {
    const lost = vi.fn();
    const pool = createPool(postgres.getConnectionUri(), lost);
    const before = await pidOf(pool);

    await terminateOthers();
    await vi.waitFor(() => expect(lost).toHaveBeenCalled());

    expect(await pidOf(pool)).not.toBe(before);
    await pool.end();
  });

  it('fails a transaction whose connection is lost, and recovers', async () => {
    const lost = vi.fn();
    const pool = createPool(postgres.getConnectionUri(), lost);

    const transaction = withTransaction(pool, async (client) => {
      await client.query('SELECT 1');
      await terminateOthers();
      await client.query('SELECT 1');
    });

    await expect(transaction).rejects.toThrow();
    // The broken connection was destroyed, not handed to the next caller.
    expect(await pidOf(pool)).toBeGreaterThan(0);
    expect(pool.totalCount).toBe(1);
    await pool.end();
  });

  it('keeps a healthy connection after a failed transaction', async () => {
    const pool = createPool(postgres.getConnectionUri());
    const before = await pidOf(pool);

    await expect(
      withTransaction(pool, async (client) => {
        await client.query('SELECT 1/0');
      }),
    ).rejects.toThrow('division by zero');

    expect(await pidOf(pool)).toBe(before);
    await pool.end();
  });
});
