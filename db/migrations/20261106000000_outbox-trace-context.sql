-- Up Migration
-- The W3C trace context of whoever wrote the row, so the relay can publish
-- the message in the same trace. NULL when tracing is off.
ALTER TABLE outbox ADD COLUMN trace_context jsonb;

-- Down Migration
ALTER TABLE outbox DROP COLUMN trace_context;
