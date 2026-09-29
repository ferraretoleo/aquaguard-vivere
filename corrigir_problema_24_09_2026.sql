-- Correção manual opcional do registro mostrado no histórico.
-- O AquaGuard também aplica esta correção automaticamente ao iniciar.

UPDATE maintenances
SET problems_found = notes,
    notes = NULL,
    updated_at = now()
WHERE problems_found IS NULL
  AND notes = 'Pequeno vazamento na tubulação do motor'
  AND (started_at AT TIME ZONE 'America/Sao_Paulo')::date = DATE '2026-09-24';
