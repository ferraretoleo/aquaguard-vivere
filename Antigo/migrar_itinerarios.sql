-- Migração opcional para execução manual no Neon.
-- O AquaGuard também aplica estas alterações automaticamente ao iniciar.

CREATE TABLE IF NOT EXISTS itineraries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title varchar(180) NOT NULL,
  service_date date NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_itineraries_date_user ON itineraries(service_date DESC, created_by);

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
