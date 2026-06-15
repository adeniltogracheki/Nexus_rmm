CREATE TYPE "public"."papel" AS ENUM('owner', 'admin', 'operator', 'viewer');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"slug" text NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usuarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"senha_hash" text NOT NULL,
	"papel" "papel" DEFAULT 'viewer' NOT NULL,
	"mfa_secret" text,
	"ativo" boolean DEFAULT true NOT NULL,
	"ultimo_login" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_usuarios_tenant_email" UNIQUE("tenant_id","email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tokens_enrollment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"descricao" text,
	"max_usos" integer DEFAULT 1 NOT NULL,
	"usos" integer DEFAULT 0 NOT NULL,
	"expira_em" timestamp with time zone,
	"criado_por" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "maquinas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"fingerprint" text NOT NULL,
	"chave_publica_agente" text,
	"so_versao" text,
	"versao_agente" text,
	"tags" text[],
	"online" boolean DEFAULT false NOT NULL,
	"visto_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maquinas_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "servicos_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"maquina_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"display_name" text,
	"estado" text NOT NULL,
	"tipo_inicializacao" text NOT NULL,
	"categoria" text DEFAULT 'outro' NOT NULL,
	"watchdog_ativo" boolean DEFAULT false NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_servico_por_maquina" UNIQUE("maquina_id","nome")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessoes_remotas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"maquina_id" uuid NOT NULL,
	"usuario_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"status" text NOT NULL,
	"ip_origem" "inet",
	"conectado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"encerrado_em" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "logs_servicos_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"usuario_id" uuid,
	"maquina_id" uuid NOT NULL,
	"servico_nome" text NOT NULL,
	"acao_executada" text NOT NULL,
	"tipo_inicializacao_anterior" text,
	"status_resultado" text NOT NULL,
	"detalhes_erro" text,
	"hash_anterior" text,
	"hash_registro" text,
	"executado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tokens_enrollment" ADD CONSTRAINT "tokens_enrollment_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maquinas" ADD CONSTRAINT "maquinas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "servicos_windows" ADD CONSTRAINT "servicos_windows_maquina_id_maquinas_id_fk" FOREIGN KEY ("maquina_id") REFERENCES "public"."maquinas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessoes_remotas" ADD CONSTRAINT "sessoes_remotas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessoes_remotas" ADD CONSTRAINT "sessoes_remotas_maquina_id_maquinas_id_fk" FOREIGN KEY ("maquina_id") REFERENCES "public"."maquinas"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessoes_remotas" ADD CONSTRAINT "sessoes_remotas_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "logs_servicos_windows" ADD CONSTRAINT "logs_servicos_windows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "logs_servicos_windows" ADD CONSTRAINT "logs_servicos_windows_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "logs_servicos_windows" ADD CONSTRAINT "logs_servicos_windows_maquina_id_maquinas_id_fk" FOREIGN KEY ("maquina_id") REFERENCES "public"."maquinas"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_enrollment_tenant" ON "tokens_enrollment" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_maquinas_tenant" ON "maquinas" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_servicos_maquina" ON "servicos_windows" USING btree ("maquina_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_logs_maquina" ON "logs_servicos_windows" USING btree ("maquina_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_logs_usuario" ON "logs_servicos_windows" USING btree ("usuario_id");