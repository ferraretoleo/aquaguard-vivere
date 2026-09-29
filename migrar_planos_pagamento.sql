-- Migração opcional para execução manual no Neon.
-- O AquaGuard também aplica estas alterações automaticamente ao iniciar.

CREATE TABLE IF NOT EXISTS payment_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL,
  plan_type varchar(100) NOT NULL,
  included_services text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_payment_plans_created_by ON payment_plans(created_by);

ALTER TABLE locations ADD COLUMN IF NOT EXISTS payment_plan_id uuid;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS contract_value numeric(12,2);
ALTER TABLE locations ADD COLUMN IF NOT EXISTS payment_method varchar(40);
ALTER TABLE locations ADD COLUMN IF NOT EXISTS payment_type varchar(20);
ALTER TABLE locations ADD COLUMN IF NOT EXISTS monthly_amount numeric(12,2);
ALTER TABLE locations ADD COLUMN IF NOT EXISTS installment_count integer;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS installment_amount numeric(12,2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_locations_payment_plan') THEN
    ALTER TABLE locations
      ADD CONSTRAINT fk_locations_payment_plan
      FOREIGN KEY (payment_plan_id) REFERENCES payment_plans(id) ON DELETE SET NULL;
  END IF;
END $$;
ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_payment_type_check;
ALTER TABLE locations
  ADD CONSTRAINT locations_payment_type_check
  CHECK (payment_type IS NULL OR payment_type IN ('MONTHLY','INSTALLMENTS'));
ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_contract_values_check;
ALTER TABLE locations
  ADD CONSTRAINT locations_contract_values_check
  CHECK (
    (contract_value IS NULL OR contract_value >= 0) AND
    (monthly_amount IS NULL OR monthly_amount >= 0) AND
    (installment_amount IS NULL OR installment_amount >= 0) AND
    (installment_count IS NULL OR installment_count > 0)
  );
CREATE INDEX IF NOT EXISTS ix_locations_payment_plan ON locations(payment_plan_id);
