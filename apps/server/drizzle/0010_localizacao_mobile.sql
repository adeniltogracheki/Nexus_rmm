-- Localização GPS/rede para dispositivos móveis (Android, tablet).
-- Nulo para desktops e servidores — eles não reportam coordenadas.
ALTER TABLE maquinas
  ADD COLUMN IF NOT EXISTS latitude        double precision,
  ADD COLUMN IF NOT EXISTS longitude       double precision,
  ADD COLUMN IF NOT EXISTS precisao_metros real,
  ADD COLUMN IF NOT EXISTS localizacao_em  timestamptz;

-- Índice esparso: só existe para linhas com coordenadas preenchidas (< 5% das máquinas)
CREATE INDEX IF NOT EXISTS idx_maquinas_localizacao
  ON maquinas (tenant_id, latitude, longitude)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
