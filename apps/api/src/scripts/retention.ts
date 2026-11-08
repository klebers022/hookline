import { createPool, requireEnv } from '@hookline/shared';
import { runRetention } from '../retention.js';

function days(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a whole number of days, at least 1`);
  }
  return parsed;
}

const outboxDays = days('RETENTION_OUTBOX_DAYS');
const eventDays = days('RETENTION_EVENT_DAYS');

const pool = createPool(requireEnv('DATABASE_URL'));
try {
  const { events, outboxRows } = await runRetention(pool, {
    ...(outboxDays && { outboxDays }),
    ...(eventDays && { eventDays }),
  });
  console.log(
    `Deleted ${events} finished events and ${outboxRows} published outbox rows`,
  );
} finally {
  await pool.end();
}
