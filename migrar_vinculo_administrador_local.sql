-- Vínculo de usuários comuns com o prestador (Administrador Local).
ALTER TABLE users ADD COLUMN IF NOT EXISTS local_admin_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_users_local_admin ON users(local_admin_id);
-- Não atribui administradores automaticamente. Configure os vínculos em /usuarios.
