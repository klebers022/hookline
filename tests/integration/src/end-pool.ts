import type { Pool } from '@hookline/shared';

// pool.end() resolves as soon as it has asked each client to close, not when
// the clients have closed. Stopping the Postgres container in between kills
// a closing client, whose error then reaches a pool with no 'error'
// listener and fails the run as an uncaught exception. The pool emits
// 'remove' once a client has really closed, so wait for every one of them.
export async function endPool(pool: Pool): Promise<void> {
  const open = pool.totalCount;
  let removed = 0;
  const closed = new Promise<void>((resolve) => {
    if (open === 0) {
      resolve();
      return;
    }
    pool.on('remove', () => {
      removed += 1;
      if (removed === open) {
        resolve();
      }
    });
  });
  await pool.end();
  await closed;
}
