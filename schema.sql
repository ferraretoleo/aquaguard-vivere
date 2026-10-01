CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL,
  email varchar(255) NOT NULL,
  password_hash text,
  google_id varchar(255),
  role varchar(20) NOT NULL DEFAULT 'USER' CHECK (role IN ('ADMIN','LOCAL_ADMIN','USER')),
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
  document_number varchar(20),
  payment_plan_id uuid,
  contract_value numeric(12,2),
  payment_method varchar(40),
  payment_type varchar(20),
  payment_due_day smallint,
  monthly_amount numeric(12,2),
  installment_count integer,
  installment_amount numeric(12,2),
  report_emails text[] NOT NULL DEFAULT '{}',
  notification_contacts jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE locations ADD COLUMN IF NOT EXISTS notification_contacts jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS document_number varchar(20);
ALTER TABLE locations ADD COLUMN IF NOT EXISTS payment_plan_id uuid;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS contract_value numeric(12,2);
ALTER TABLE locations ADD COLUMN IF NOT EXISTS payment_method varchar(40);
ALTER TABLE locations ADD COLUMN IF NOT EXISTS payment_type varchar(20);
ALTER TABLE locations ADD COLUMN IF NOT EXISTS payment_due_day smallint;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS monthly_amount numeric(12,2);
ALTER TABLE locations ADD COLUMN IF NOT EXISTS installment_count integer;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS installment_amount numeric(12,2);

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

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check CHECK (role IN ('ADMIN','LOCAL_ADMIN','USER'));

CREATE TABLE IF NOT EXISTS user_locations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, location_id)
);
CREATE INDEX IF NOT EXISTS ix_user_locations_location ON user_locations(location_id);

INSERT INTO user_locations(user_id, location_id)
SELECT id, location_id
FROM users
WHERE location_id IS NOT NULL
ON CONFLICT DO NOTHING;

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
ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_payment_due_day_check;
ALTER TABLE locations
  ADD CONSTRAINT locations_payment_due_day_check
  CHECK (payment_due_day IS NULL OR payment_due_day BETWEEN 1 AND 31);
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
  problems_found text,
  notes text,
  quote_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  quote_total numeric(12,2),
  quote_created_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS stabilizer numeric(7,2);
ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS problems_found text;
ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS quote_items jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS quote_total numeric(12,2);
ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS quote_created_at timestamptz;

-- Corrige o registro de 24/09/2026 salvo pela tela antiga no campo Observações.
UPDATE maintenances
SET problems_found = notes,
    notes = NULL,
    updated_at = now()
WHERE problems_found IS NULL
  AND notes = 'Pequeno vazamento na tubulação do motor'
  AND (started_at AT TIME ZONE 'America/Sao_Paulo')::date = DATE '2026-09-24';
CREATE INDEX IF NOT EXISTS ix_maintenances_pool_started ON maintenances(pool_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_maintenances_status ON maintenances(status);

CREATE TABLE IF NOT EXISTS itineraries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title varchar(180) NOT NULL,
  service_date date NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  responsible_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE itineraries ADD COLUMN IF NOT EXISTS responsible_user_id uuid REFERENCES users(id) ON DELETE RESTRICT;
UPDATE itineraries SET responsible_user_id=created_by WHERE responsible_user_id IS NULL;
ALTER TABLE itineraries ALTER COLUMN responsible_user_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS ix_itineraries_date_user ON itineraries(service_date DESC, created_by);
CREATE INDEX IF NOT EXISTS ix_itineraries_responsible ON itineraries(responsible_user_id, service_date DESC);

CREATE TABLE IF NOT EXISTS itinerary_stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  itinerary_id uuid NOT NULL REFERENCES itineraries(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  position integer NOT NULL CHECK (position > 0),
  status varchar(30) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VISITED_SERVICE','VISITED_NO_SERVICE')),
  maintenance_id uuid REFERENCES maintenances(id) ON DELETE SET NULL,
  visit_notes text,
  visited_at timestamptz,
  visited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (itinerary_id, location_id),
  UNIQUE (itinerary_id, position)
);
CREATE INDEX IF NOT EXISTS ix_itinerary_stops_location ON itinerary_stops(location_id);
CREATE INDEX IF NOT EXISTS ix_itinerary_stops_status ON itinerary_stops(status);

ALTER TABLE maintenances ADD COLUMN IF NOT EXISTS itinerary_stop_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_maintenances_itinerary_stop') THEN
    ALTER TABLE maintenances
      ADD CONSTRAINT fk_maintenances_itinerary_stop
      FOREIGN KEY (itinerary_stop_id) REFERENCES itinerary_stops(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS ux_maintenances_itinerary_stop
  ON maintenances(itinerary_stop_id) WHERE itinerary_stop_id IS NOT NULL;

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

-- Mensalidades do AquaGuard, exclusivas do Administrador Geral.
CREATE TABLE IF NOT EXISTS user_subscriptions (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 plan varchar(20) NOT NULL CHECK (plan IN ('PISCINA','CONDOMINIO','PROFISSIONAL','EMPRESA')),
 monthly_amount numeric(12,2) NOT NULL CHECK (monthly_amount >= 0),
 due_day smallint NOT NULL CHECK (due_day BETWEEN 1 AND 31),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS subscription_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 competence date NOT NULL CHECK (extract(day FROM competence)=1),
 paid_on date NOT NULL,
 amount numeric(12,2) NOT NULL CHECK (amount > 0),
 notes text NOT NULL DEFAULT '',
 created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,competence)
);
