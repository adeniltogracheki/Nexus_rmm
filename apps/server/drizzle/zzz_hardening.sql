-- ============================================================================
--  Nexus RMM — Hardening (idempotente; aplicado por migrate.ts APÓS as migrations)
--  1) Cadeia de hash da auditoria (tamper-evident)
--  2) Imutabilidade: REVOKE UPDATE/DELETE
--  3) RLS multi-tenant (defesa em profundidade)
-- ============================================================================

-- Extensões (uuid-ossp, pgcrypto) são criadas no init do Postgres como
-- superusuário (infra/initdb/01-nexus-app-role.sh), pois nexus_app não tem
-- privilégio para CREATE EXTENSION. Aqui apenas as usamos (digest, etc).

-- ── 1) Cadeia de hash ───────────────────────────────────────────────────────
-- Payload canônico de um registro de auditoria. Usado tanto pelo trigger
-- (ao inserir) quanto pela verificação (ao auditar), garantindo o MESMO cálculo.
CREATE OR REPLACE FUNCTION nexus_audit_payload(r logs_servicos_windows)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    coalesce(r.hash_anterior, '')              || '|' ||
    coalesce(r.tenant_id::text, '')            || '|' ||
    coalesce(r.usuario_id::text, '')           || '|' ||
    coalesce(r.maquina_id::text, '')           || '|' ||
    coalesce(r.servico_nome, '')               || '|' ||
    coalesce(r.acao_executada, '')             || '|' ||
    coalesce(r.tipo_inicializacao_anterior, '')|| '|' ||
    coalesce(r.status_resultado, '')           || '|' ||
    coalesce(r.detalhes_erro, '')              || '|' ||
    coalesce(r.executado_em::text, '');
$$;

-- BEFORE INSERT: lê o último hash_registro -> hash_anterior; calcula hash_registro.
-- NOTA: em inserts concorrentes há uma corrida (dois inserts podem ler o mesmo
-- "último"). Aceitável na Fase 0; será serializado (advisory lock) em fase futura.
CREATE OR REPLACE FUNCTION nexus_audit_hash_chain()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_prev text;
BEGIN
  SELECT hash_registro
    INTO v_prev
    FROM logs_servicos_windows
   ORDER BY executado_em DESC, id DESC
   LIMIT 1;

  NEW.hash_anterior := v_prev;
  NEW.hash_registro := encode(digest(nexus_audit_payload(NEW), 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_hash_chain ON logs_servicos_windows;
CREATE TRIGGER trg_audit_hash_chain
  BEFORE INSERT ON logs_servicos_windows
  FOR EACH ROW
  EXECUTE FUNCTION nexus_audit_hash_chain();

-- ── 2) Imutabilidade ────────────────────────────────────────────────────────
-- Bloqueia UPDATE/DELETE para PUBLIC. NOTA (ver README): na Fase 0 a role da app
-- é dona da tabela e o dono ignora o REVOKE — a garantia real é a cadeia de hash.
REVOKE UPDATE, DELETE ON logs_servicos_windows FROM PUBLIC;

-- ── 3) RLS multi-tenant ─────────────────────────────────────────────────────
-- Habilita RLS + FORCE e cria a policy de isolamento nas tabelas com tenant_id.
-- A app deve executar `SET app.tenant_id = '<uuid>'` por conexão.
-- tenants e usuarios ficam FORA do RLS: o login é uma busca cross-tenant por email.
ALTER TABLE usuarios NO FORCE ROW LEVEL SECURITY;
ALTER TABLE usuarios DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON usuarios;

DO $$
DECLARE
  t text;
  tabelas text[] := ARRAY[
    'grupos',
    'tokens_enrollment',
    'maquinas',
    'sessoes_remotas',
    'logs_servicos_windows',
    'inventarios'
  ];
BEGIN
  FOREACH t IN ARRAY tabelas LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      || 'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid);',
      t
    );
  END LOOP;
END;
$$;

-- Soft-delete de maquinas (idempotente) — adicionado p/ feature "Remover maquina".
ALTER TABLE maquinas ADD COLUMN IF NOT EXISTS arquivada boolean NOT NULL DEFAULT false;
ALTER TABLE maquinas ADD COLUMN IF NOT EXISTS arquivada_em timestamptz;

-- Alertas/notificacoes (idempotente) — tabela + RLS por tenant.
DO $$ BEGIN CREATE TYPE severidade_alerta AS ENUM ('info','aviso','critico'); EXCEPTION WHEN duplicate_object THEN null; END $$;
CREATE TABLE IF NOT EXISTS alertas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  maquina_id uuid REFERENCES maquinas(id) ON DELETE CASCADE,
  tipo text NOT NULL,
  severidade severidade_alerta NOT NULL DEFAULT 'info',
  mensagem text NOT NULL,
  lida boolean NOT NULL DEFAULT false,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alertas_tenant ON alertas(tenant_id);
CREATE INDEX IF NOT EXISTS idx_alertas_lida ON alertas(tenant_id, lida);
ALTER TABLE alertas ENABLE ROW LEVEL SECURITY;
ALTER TABLE alertas FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON alertas;
CREATE POLICY tenant_isolation ON alertas USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON alertas TO nexus_app;

-- Chamados / Helpdesk (idempotente) — tabelas + RLS + GRANT.
DO $$ BEGIN CREATE TYPE status_chamado AS ENUM ('aberto','em_andamento','resolvido','fechado'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE prioridade_chamado AS ENUM ('baixa','media','alta','critica'); EXCEPTION WHEN duplicate_object THEN null; END $$;
CREATE TABLE IF NOT EXISTS chamados (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  maquina_id uuid REFERENCES maquinas(id) ON DELETE SET NULL,
  titulo text NOT NULL,
  descricao text NOT NULL,
  status status_chamado NOT NULL DEFAULT 'aberto',
  prioridade prioridade_chamado NOT NULL DEFAULT 'media',
  aberto_por uuid NOT NULL REFERENCES usuarios(id),
  atribuido_a uuid REFERENCES usuarios(id),
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chamado_comentarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  chamado_id uuid NOT NULL REFERENCES chamados(id) ON DELETE CASCADE,
  autor_id uuid NOT NULL REFERENCES usuarios(id),
  texto text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chamados_tenant ON chamados(tenant_id);
CREATE INDEX IF NOT EXISTS idx_chamados_status ON chamados(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_comentarios_chamado ON chamado_comentarios(chamado_id);
DO $$ BEGIN
  EXECUTE 'ALTER TABLE chamados ENABLE ROW LEVEL SECURITY'; EXECUTE 'ALTER TABLE chamados FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON chamados';
  EXECUTE 'CREATE POLICY tenant_isolation ON chamados USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid)';
  EXECUTE 'ALTER TABLE chamado_comentarios ENABLE ROW LEVEL SECURITY'; EXECUTE 'ALTER TABLE chamado_comentarios FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON chamado_comentarios';
  EXECUTE 'CREATE POLICY tenant_isolation ON chamado_comentarios USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid)';
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON chamados TO nexus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON chamado_comentarios TO nexus_app;

-- Config de notificacoes externas (idempotente) — sem RLS (consultada por tenant_id PK) + GRANT.
CREATE TABLE IF NOT EXISTS notificacoes_config (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  webhook_url text,
  formato text NOT NULL DEFAULT 'generico',
  telegram_chat_id text,
  min_severidade text NOT NULL DEFAULT 'aviso',
  ativo boolean NOT NULL DEFAULT false
);
GRANT SELECT, INSERT, UPDATE, DELETE ON notificacoes_config TO nexus_app;

-- Historico de metricas (idempotente) — tabela + RLS + GRANT.
CREATE TABLE IF NOT EXISTS metricas_historico (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  maquina_id uuid NOT NULL REFERENCES maquinas(id) ON DELETE CASCADE,
  cpu integer NOT NULL,
  ram integer NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_methist_maq_data ON metricas_historico(maquina_id, criado_em);
DO $$ BEGIN
  EXECUTE 'ALTER TABLE metricas_historico ENABLE ROW LEVEL SECURITY'; EXECUTE 'ALTER TABLE metricas_historico FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON metricas_historico';
  EXECUTE 'CREATE POLICY tenant_isolation ON metricas_historico USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid)';
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON metricas_historico TO nexus_app;

-- Tarefas agendadas (idempotente) — sem RLS (agendador consulta todos os tenants) + GRANT.
CREATE TABLE IF NOT EXISTS tarefas_agendadas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  maquina_id uuid NOT NULL REFERENCES maquinas(id) ON DELETE CASCADE,
  nome text NOT NULL,
  comando text NOT NULL,
  shell text NOT NULL DEFAULT 'powershell',
  frequencia text NOT NULL DEFAULT 'diaria',
  horario text,
  data_unica timestamptz,
  ativo boolean NOT NULL DEFAULT true,
  proxima_exec timestamptz,
  ultima_exec timestamptz,
  ultimo_status text,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tarefas_proxima ON tarefas_agendadas(ativo, proxima_exec);
GRANT SELECT, INSERT, UPDATE, DELETE ON tarefas_agendadas TO nexus_app;

-- Config global de seguranca (idempotente) + GRANT + linha inicial.
CREATE TABLE IF NOT EXISTS config_seguranca (
  id text PRIMARY KEY DEFAULT 'global',
  apenas_brasil boolean NOT NULL DEFAULT false,
  forcar_2fa boolean NOT NULL DEFAULT false,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
INSERT INTO config_seguranca (id) VALUES ('global') ON CONFLICT (id) DO NOTHING;
GRANT SELECT, INSERT, UPDATE ON config_seguranca TO nexus_app;

-- Escopo por empresa no usuário (null = todas as empresas).
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS empresas_permitidas jsonb;

-- Permissoes granulares por usuario (null = padrao do papel).
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS permissoes jsonb;

-- Marca/identidade nos relatorios.
ALTER TABLE config_seguranca ADD COLUMN IF NOT EXISTS nome_marca text;
ALTER TABLE config_seguranca ADD COLUMN IF NOT EXISTS logo_url text;

-- Log de presenca (uptime/SLA).
CREATE TABLE IF NOT EXISTS presenca_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  maquina_id uuid NOT NULL,
  online boolean NOT NULL,
  em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_presenca_maquina_em ON presenca_log (maquina_id, em);
GRANT SELECT, INSERT ON presenca_log TO nexus_app;

-- Relatorio semanal automatico.
ALTER TABLE notificacoes_config ADD COLUMN IF NOT EXISTS relatorio_semanal boolean NOT NULL DEFAULT false;
ALTER TABLE notificacoes_config ADD COLUMN IF NOT EXISTS relatorio_ultimo_envio timestamptz;

-- Ciclo de vida / manutencao do ativo.
ALTER TABLE maquinas ADD COLUMN IF NOT EXISTS responsavel text;
CREATE TABLE IF NOT EXISTS manutencoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  maquina_id uuid NOT NULL,
  tipo text NOT NULL DEFAULT 'corretiva',
  descricao text NOT NULL,
  pecas_trocadas text,
  tecnico text,
  custo text,
  status_manut text NOT NULL DEFAULT 'concluida',
  data_manutencao timestamptz NOT NULL DEFAULT now(),
  proxima_preventiva timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_manutencoes_maquina ON manutencoes (maquina_id, data_manutencao);
GRANT SELECT, INSERT, UPDATE, DELETE ON manutencoes TO nexus_app;

-- Dedup de alerta de preventiva vencida.
ALTER TABLE manutencoes ADD COLUMN IF NOT EXISTS alertado_em timestamptz;

-- Anexos de manutencao (foto/nota fiscal).
CREATE TABLE IF NOT EXISTS manutencao_anexos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  manutencao_id uuid NOT NULL,
  nome text NOT NULL,
  tipo text NOT NULL,
  tamanho integer NOT NULL DEFAULT 0,
  dados text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_anexos_manut ON manutencao_anexos (manutencao_id);
GRANT SELECT, INSERT, DELETE ON manutencao_anexos TO nexus_app;

-- SMTP (e-mail) por tenant.
ALTER TABLE notificacoes_config ADD COLUMN IF NOT EXISTS email_ativo boolean NOT NULL DEFAULT false;
ALTER TABLE notificacoes_config ADD COLUMN IF NOT EXISTS smtp_host text;
ALTER TABLE notificacoes_config ADD COLUMN IF NOT EXISTS smtp_port integer;
ALTER TABLE notificacoes_config ADD COLUMN IF NOT EXISTS smtp_seguro boolean NOT NULL DEFAULT true;
ALTER TABLE notificacoes_config ADD COLUMN IF NOT EXISTS smtp_user text;
ALTER TABLE notificacoes_config ADD COLUMN IF NOT EXISTS smtp_pass text;
ALTER TABLE notificacoes_config ADD COLUMN IF NOT EXISTS smtp_from text;
ALTER TABLE notificacoes_config ADD COLUMN IF NOT EXISTS email_destinatarios text;

-- MFA pendente (só vira ativo após confirmar no verify).
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS mfa_pendente text;

-- Fim do periodo de teste (trial 7 dias).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_expira_em timestamptz;

-- Assinatura paga ate (renovacao mensal).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pago_ate timestamptz;

-- Dedup dos avisos de cobranca por e-mail.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS aviso_vencimento_em timestamptz;
