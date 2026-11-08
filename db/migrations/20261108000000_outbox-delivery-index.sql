-- Up Migration
-- Deleting a delivery cascades to its outbox rows, and retention checks a
-- delivery's unpublished rows. Without this index both scan the whole
-- outbox once per delivery.
CREATE INDEX outbox_delivery_id_idx ON outbox (delivery_id);

-- Down Migration
DROP INDEX outbox_delivery_id_idx;
