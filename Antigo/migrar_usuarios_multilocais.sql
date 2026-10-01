BEGIN;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check CHECK (role IN ('ADMIN','LOCAL_ADMIN','USER'));

ALTER TABLE users ALTER COLUMN location_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS user_locations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, location_id)
);

CREATE INDEX IF NOT EXISTS ix_user_locations_location
  ON user_locations(location_id);

INSERT INTO user_locations(user_id, location_id)
SELECT id, location_id
FROM users
WHERE location_id IS NOT NULL
ON CONFLICT DO NOTHING;

COMMIT;

SELECT
  u.name,
  u.email,
  u.role,
  COALESCE(string_agg(l.name, ', ' ORDER BY l.name), 'Todos os locais') AS locais
FROM users u
LEFT JOIN user_locations ul ON ul.user_id=u.id
LEFT JOIN locations l ON l.id=ul.location_id
GROUP BY u.id, u.name, u.email, u.role
ORDER BY u.name;
