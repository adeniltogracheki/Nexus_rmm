-- Criticidade e permissão de IA por máquina
ALTER TABLE "maquinas"
  ADD COLUMN IF NOT EXISTS "criticidade" text NOT NULL DEFAULT 'operacional',
  ADD COLUMN IF NOT EXISTS "ia_remediacão_ativa" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "ia_acoes_permitidas" jsonb;

-- Telegram bot dedicado + toggles por tipo de alerta
ALTER TABLE "notificacoes_config"
  ADD COLUMN IF NOT EXISTS "telegram_bot_token" text,
  ADD COLUMN IF NOT EXISTS "telegram_chat_id_bot" text,
  ADD COLUMN IF NOT EXISTS "telegram_ativo" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "notif_critico" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "notif_aviso" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "notif_offline" boolean NOT NULL DEFAULT true;

-- Regras de threshold por tenant (pode ser sobrescrito por grupo no futuro)
CREATE TABLE IF NOT EXISTS "regras_alerta" (
  "tenant_id"              uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "cpu_limite_pct"         integer NOT NULL DEFAULT 90,
  "cpu_janela_min"         integer NOT NULL DEFAULT 2,
  "ram_limite_pct"         integer NOT NULL DEFAULT 90,
  "ram_janela_min"         integer NOT NULL DEFAULT 2,
  "disco_livre_min_pct"    integer NOT NULL DEFAULT 10,
  "offline_tolerancia_min" integer NOT NULL DEFAULT 5,
  "ia_remediacão_global"   boolean NOT NULL DEFAULT false,
  "criado_em"              timestamptz NOT NULL DEFAULT now()
);

-- Log imutável de remediações executadas pela IA
CREATE TABLE IF NOT EXISTS "remediacoes_ia" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"         uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "maquina_id"        uuid NOT NULL REFERENCES "maquinas"("id") ON DELETE CASCADE,
  "trigger_descricao" text NOT NULL,
  "acoes_executadas"  jsonb,
  "metricas_antes"    jsonb,
  "metricas_depois"   jsonb,
  "status"            text NOT NULL DEFAULT 'executando',
  "ia_modelo"         text,
  "duracao_ms"        integer,
  "criado_em"         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_remediacoes_tenant" ON "remediacoes_ia" ("tenant_id", "criado_em" DESC);
CREATE INDEX IF NOT EXISTS "idx_remediacoes_maquina" ON "remediacoes_ia" ("maquina_id");
