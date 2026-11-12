import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

// Called when a connection breaks outside a query: Postgres restarting, a
// network cut, an administrator ending the session.
export type ConnectionErrorHandler = (error: Error) => void;

// A connection Postgres closes (on a restart it sends 57P01,
// admin_shutdown) emits 'error'. An 'error' event with no listener ends
// the Node process, so every connection gets one: an idle connection is
// dropped by the pool, and one in use fails its query, which the caller
// handles. Without this, a database restart crashed the API and the relay.
export function createPool(
  connectionString: string,
  onConnectionError: ConnectionErrorHandler = () => {},
): Pool {
  const pool = new pg.Pool({ connectionString });
  pool.on('error', onConnectionError);
  pool.on('connect', (client) => client.on('error', onConnectionError));
  return pool;
}

export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    client.release();
    return result;
  } catch (error) {
    // On a broken connection the rollback fails too. The original error is
    // the one worth reporting, and the connection is destroyed instead of
    // going back to the pool for the next caller to trip on.
    let broken: Error | undefined;
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      broken = rollbackError as Error;
    }
    client.release(broken);
    throw error;
  }
}
