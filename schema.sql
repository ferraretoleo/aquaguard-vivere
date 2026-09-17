CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL,
  email varchar(255) NOT NULL,
  password_hash text,
  google_id varchar(255),
  role varchar(20) NOT NULL DEFAULT 'USER' CHECK (role IN ('ADMIN','USER')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email_lower ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_google_id ON users (google_id) WHERE google_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(180) NOT NULL,
  address text,
  report_emails text[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS location_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_users_location') THEN
    ALTER TABLE users
      ADD CONSTRAINT fk_users_location
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ix_users_location ON users(location_id);

CREATE TABLE IF NOT EXISTS pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  name varchar(180) NOT NULL,
  pool_location varchar(180),
  volume_liters integer CHECK (volume_liters IS NULL OR volume_liters >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_pools_location ON pools(location_id);

CREATE TABLE IF NOT EXISTS maintenances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES pools(id) ON DELETE RESTRICT,
  executor varchar(180) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'STARTED' CHECK (status IN ('STARTED','COMPLETED','CANCELLED')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  ph numeric(4,2),
  chlorine numeric(6,2),
  alkalinity numeric(7,2),
  stabilizer numeric(7,2),
  services text[] NOT NULL DEFAULT '{}',
  notes text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS stabilizer numeric(7,2);
CREATE INDEX IF NOT EXISTS ix_maintenances_pool_started ON maintenances(pool_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_maintenances_status ON maintenances(status);

CREATE TABLE IF NOT EXISTS maintenance_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  maintenance_id uuid NOT NULL REFERENCES maintenances(id) ON DELETE CASCADE,
  phase varchar(10) NOT NULL CHECK (phase IN ('START','END')),
  file_name varchar(255) NOT NULL,
  mime_type varchar(100) NOT NULL,
  file_data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_maintenance_photos_maintenance ON maintenance_photos(maintenance_id);

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key varchar(100) PRIMARY KEY,
  setting_value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
