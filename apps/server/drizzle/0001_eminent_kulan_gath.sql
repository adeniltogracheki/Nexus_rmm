CREATE TYPE "public"."tipo_grupo" AS ENUM('empresa', 'departamento');--> statement-breakpoint
CREATE TYPE "public"."tipo_maquina" AS ENUM('pc', 'servidor');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "grupos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"tipo" "tipo_grupo" DEFAULT 'empresa' NOT NULL,
	"parent_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "maquinas" ADD COLUMN "grupo_id" uuid;--> statement-breakpoint
ALTER TABLE "maquinas" ADD COLUMN "tipo_maquina" "tipo_maquina" DEFAULT 'pc' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "grupos" ADD CONSTRAINT "grupos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "grupos" ADD CONSTRAINT "fk_grupos_parent" FOREIGN KEY ("parent_id") REFERENCES "public"."grupos"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_grupos_tenant" ON "grupos" USING btree ("tenant_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maquinas" ADD CONSTRAINT "maquinas_grupo_id_grupos_id_fk" FOREIGN KEY ("grupo_id") REFERENCES "public"."grupos"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_maquinas_grupo" ON "maquinas" USING btree ("grupo_id");