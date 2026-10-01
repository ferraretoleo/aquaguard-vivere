-- Migração opcional para execução manual no Neon.
-- O AquaGuard também aplica esta alteração automaticamente ao iniciar.

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS document_number varchar(20);
