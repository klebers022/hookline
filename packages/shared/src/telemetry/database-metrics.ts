import { Gauge, type Registry } from 'prom-client';
import type { Pool } from '../db/pool.js';

interface WarnLogger {
  warn(details: object, message: string): void;
}

// Gauges that read the database's state on each scrape: the outbox backlog
// and the open circuit breakers. The API and the relay both register them,
// so they keep reporting when either is down. A relay that stopped cannot
// say its own outbox is stuck. Every process reports the same values, so
// dashboards and alerts take their max(). A failed read keeps the last value
// instead of failing the whole scrape.
export function registerDatabaseGauges(
  registry: Registry,
  pool: Pool,
  logger: WarnLogger,
): void {
  const registers = [registry];

  function gauge(name: string, help: string, sql: string): void {
    new Gauge({
      name,
      help,
      registers,
      async collect() {
        try {
          const { rows } = await pool.query<{ value: number }>(sql);
          this.set(rows[0]?.value ?? 0);
        } catch (error) {
          logger.warn({ err: error, metric: name }, 'Failed to read metric');
        }
      },
    });
  }

  gauge(
    'hookline_outbox_pending',
    'Outbox rows waiting to be published.',
    'SELECT count(*)::int AS value FROM outbox WHERE published_at IS NULL',
  );
  // Grows only when publishing stops, so it is the outbox's health signal.
  gauge(
    'hookline_outbox_oldest_pending_age_seconds',
    'Age of the oldest outbox row waiting to be published.',
    `SELECT coalesce(extract(epoch FROM now() - min(created_at)), 0)::float8
       AS value
     FROM (SELECT created_at FROM outbox WHERE published_at IS NULL
           ORDER BY id LIMIT 1) oldest`,
  );
  gauge(
    'hookline_endpoints_circuit_open',
    'Endpoints whose circuit breaker is open.',
    `SELECT count(*)::int AS value FROM endpoints
     WHERE circuit_open_until > now()`,
  );
}
