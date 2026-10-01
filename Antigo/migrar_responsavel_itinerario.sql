BEGIN;

ALTER TABLE itineraries
  ADD COLUMN IF NOT EXISTS responsible_user_id uuid REFERENCES users(id) ON DELETE RESTRICT;

UPDATE itineraries
SET responsible_user_id = created_by
WHERE responsible_user_id IS NULL;

ALTER TABLE itineraries
  ALTER COLUMN responsible_user_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS ix_itineraries_responsible
  ON itineraries(responsible_user_id, service_date DESC);

COMMIT;
