CREATE TABLE IF NOT EXISTS "inventarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"maquina_id" uuid NOT NULL,
	"hardware" jsonb NOT NULL,
	"so" jsonb NOT NULL,
	"rede" jsonb NOT NULL,
	"software" jsonb NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventarios_maquina_id_unique" UNIQUE("maquina_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventarios" ADD CONSTRAINT "inventarios_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventarios" ADD CONSTRAINT "inventarios_maquina_id_maquinas_id_fk" FOREIGN KEY ("maquina_id") REFERENCES "public"."maquinas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inventarios_tenant" ON "inventarios" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inventarios_maquina" ON "inventarios" USING btree ("maquina_id");