-- Migração opcional para execução manual no Neon.
-- O AquaGuard também aplica esta alteração automaticamente ao iniciar.

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS notification_contacts jsonb NOT NULL DEFAULT '[]'::jsonb;
