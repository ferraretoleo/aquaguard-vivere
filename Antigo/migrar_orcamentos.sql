-- Migração opcional para execução manual no Neon.
-- O AquaGuard também aplica estas alterações automaticamente ao iniciar.

ALTER TABLE maintenances
  ADD COLUMN IF NOT EXISTS quote_items jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE maintenances
  ADD COLUMN IF NOT EXISTS quote_total numeric(12,2);

ALTER TABLE maintenances
  ADD COLUMN IF NOT EXISTS quote_created_at timestamptz;
