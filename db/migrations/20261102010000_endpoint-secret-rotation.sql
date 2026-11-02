-- Up Migration
ALTER TABLE endpoints
  ADD COLUMN previous_secret_encrypted text,
  ADD COLUMN previous_secret_expires_at timestamptz;

-- Down Migration
ALTER TABLE endpoints
  DROP COLUMN previous_secret_expires_at,
  DROP COLUMN previous_secret_encrypted;
