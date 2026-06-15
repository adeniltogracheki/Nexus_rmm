-- Adiciona colunas adicionadas ao schema de maquinas que ainda não existem no DB.
-- criticidade: nível de impacto da máquina (operacional | importante | critico | missao_critica)
-- ia_remediacão_ativa / ia_acoes_permitidas: controle de remediação automática por IA por máquina

ALTER TABLE "maquinas"
  ADD COLUMN IF NOT EXISTS "criticidade" text NOT NULL DEFAULT 'operacional',
  ADD COLUMN IF NOT EXISTS "ia_remediacão_ativa" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "ia_acoes_permitidas" jsonb;
