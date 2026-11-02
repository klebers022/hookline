-- Up Migration
CREATE TABLE projects (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  key_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX api_keys_project_id_idx ON api_keys (project_id);

CREATE TABLE endpoints (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  url text NOT NULL,
  secret_encrypted text NOT NULL,
  event_types text[] NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'deleted')),
  consecutive_failures integer NOT NULL DEFAULT 0,
  circuit_open_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX endpoints_project_id_idx ON endpoints (project_id, id);
CREATE INDEX endpoints_event_types_idx ON endpoints USING gin (event_types);

CREATE TABLE events (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX events_project_id_idx ON events (project_id, id);
CREATE UNIQUE INDEX events_idempotency_key_idx ON events (project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE deliveries (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL REFERENCES endpoints (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'retrying', 'succeeded', 'dead')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, endpoint_id)
);

CREATE INDEX deliveries_endpoint_id_idx ON deliveries (endpoint_id, id);
CREATE INDEX deliveries_status_idx ON deliveries (status);

CREATE TABLE delivery_attempts (
  id uuid PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES deliveries (id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  started_at timestamptz NOT NULL,
  duration_ms integer NOT NULL,
  response_status integer,
  error_code text,
  response_snippet text,
  UNIQUE (delivery_id, attempt_number)
);

CREATE TABLE outbox (
  id bigserial PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES deliveries (id) ON DELETE CASCADE,
  routing_key text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

-- Down Migration
DROP TABLE outbox;
DROP TABLE delivery_attempts;
DROP TABLE deliveries;
DROP TABLE events;
DROP TABLE endpoints;
DROP TABLE api_keys;
DROP TABLE projects;
