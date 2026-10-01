-- AquaGuard
-- Limpa todos os dados operacionais e cadastros, preservando somente
-- o único usuário com perfil ADMIN (Administrador Geral).
--
-- ATENÇÃO: esta operação não pode ser desfeita sem backup.

BEGIN;

LOCK TABLE users IN EXCLUSIVE MODE;

DO $$
DECLARE
  admin_count integer;
BEGIN
  SELECT count(*) INTO admin_count
  FROM users
  WHERE role = 'ADMIN';

  IF admin_count <> 1 THEN
    RAISE EXCEPTION
      'Limpeza cancelada: esperado exatamente 1 Administrador Geral, mas foram encontrados %.',
      admin_count;
  END IF;
END $$;

-- Fotos e serviços
DELETE FROM maintenance_photos;

-- Remove o vínculo circular entre manutenção e parada do itinerário.
UPDATE maintenances
SET itinerary_stop_id = NULL
WHERE itinerary_stop_id IS NOT NULL;

-- Mensalidades e assinaturas do AquaGuard
DELETE FROM subscription_payments;
DELETE FROM user_subscriptions;

-- Itinerários
DELETE FROM itinerary_stops;
DELETE FROM itineraries;

-- Manutenções e piscinas
DELETE FROM maintenances;
DELETE FROM pools;

-- Remove vínculos antigos e atuais dos usuários com os locais.
DELETE FROM user_locations;
UPDATE users
SET location_id = NULL,
    updated_at = now()
WHERE location_id IS NOT NULL;

-- Locais e planos de pagamento
DELETE FROM locations;
DELETE FROM payment_plans;

-- Configurações gerais cadastradas no sistema
DELETE FROM app_settings;

-- Preserva somente o Administrador Geral.
DELETE FROM users
WHERE role <> 'ADMIN';

COMMIT;

-- Conferência após a limpeza.
SELECT id, name, email, role, is_active
FROM users
ORDER BY name;

SELECT
  (SELECT count(*) FROM users) AS usuarios,
  (SELECT count(*) FROM locations) AS locais,
  (SELECT count(*) FROM pools) AS piscinas,
  (SELECT count(*) FROM maintenances) AS manutencoes,
  (SELECT count(*) FROM itineraries) AS itinerarios,
  (SELECT count(*) FROM payment_plans) AS planos_pagamento;
