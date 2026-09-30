BEGIN;

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS payment_due_day smallint;

ALTER TABLE locations
  DROP CONSTRAINT IF EXISTS locations_payment_due_day_check;

ALTER TABLE locations
  ADD CONSTRAINT locations_payment_due_day_check
  CHECK (payment_due_day IS NULL OR payment_due_day BETWEEN 1 AND 31);

COMMIT;
