-- ATENÇÃO: este script apaga definitivamente todo o histórico de manutenções
-- e suas fotos. Locais, usuários e piscinas são preservados.

BEGIN;

DELETE FROM maintenance_photos;
DELETE FROM maintenances;

COMMIT;

-- Conferência após a limpeza: os três primeiros totais devem permanecer
-- e o total de manutenções deve ser zero.
SELECT
  (SELECT count(*) FROM locations) AS locais,
  (SELECT count(*) FROM users) AS usuarios,
  (SELECT count(*) FROM pools) AS piscinas,
  (SELECT count(*) FROM maintenances) AS manutencoes;
