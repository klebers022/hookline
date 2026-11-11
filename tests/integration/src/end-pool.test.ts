import { createPool, type Pool } from '@hookline/shared';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endPool } from './end-pool.js';

describe('endPool', () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
  });

  afterAll(async () => {
    await container?.stop();
  });

  // A pool with five open clients, and a record of which have closed.
  async function busyPool() {
    const pool = createPool(container.getConnectionUri());
    const clients: { closed: boolean }[] = [];
    pool.on('connect', (client) => {
      const record = { closed: false };
      clients.push(record);
      client.once('end', () => {
        record.closed = true;
      });
    });
    await Promise.all(
      Array.from({ length: 5 }, () => pool.query('SELECT pg_sleep(0.05)')),
    );
    expect(clients).toHaveLength(5);
    return { pool, clients };
  }

  it('shows the race: pool.end() returns while clients are still closing', async () => {
    const { pool, clients } = await busyPool();
    await pool.end();
    expect(clients.some((client) => !client.closed)).toBe(true);
  });

  it('returns only once every client has closed', async () => {
    const { pool, clients } = await busyPool();
    await endPool(pool);
    expect(clients.every((client) => client.closed)).toBe(true);
  });

  it('closes a pool that never opened a client', async () => {
    const pool: Pool = createPool(container.getConnectionUri());
    await expect(endPool(pool)).resolves.toBeUndefined();
  });
});
