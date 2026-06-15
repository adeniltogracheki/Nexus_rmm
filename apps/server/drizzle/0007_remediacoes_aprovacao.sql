-- Aprovações humanas para remediação IA
CREATE TABLE IF NOT EXISTS remediacoes_aprovacao (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  maquina_id        uuid NOT NULL REFERENCES maquinas(id) ON DELETE CASCADE,
  codigo            text NOT NULL,
  trigger_descricao text NOT NULL,
  acoes_propostas   jsonb NOT NULL,
  metricas_antes    jsonb,
  status            text NOT NULL DEFAULT 'aguardando',
  aprovado_por      text,
  expires_at        timestamptz NOT NULL,
  criado_em         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_remed_aprov_codigo  ON remediacoes_aprovacao (codigo);
CREATE INDEX        IF NOT EXISTS idx_remed_aprov_tenant  ON remediacoes_aprovacao (tenant_id, status);
CREATE INDEX        IF NOT EXISTS idx_remed_aprov_expires ON remediacoes_aprovacao (expires_at) WHERE status = 'aguardando';

-- Webhook secrets por tenant (para Telegram + WA)
ALTER TABLE notificacoes_config
  ADD COLUMN IF NOT EXISTS telegram_webhook_secret text,
  ADD COLUMN IF NOT EXISTS ia_remediacao_ativa boolean NOT NULL DEFAULT false;
