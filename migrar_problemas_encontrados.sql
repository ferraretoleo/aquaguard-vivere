-- Migração opcional para execução manual no Neon.
-- O AquaGuard também aplica esta alteração automaticamente ao iniciar.

ALTER TABLE maintenances
  ADD COLUMN IF NOT EXISTS problems_found text;
