ALTER TABLE "maquinas" ADD COLUMN "bios_uuid" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_maquinas_tenant_bios" ON "maquinas" USING btree ("tenant_id","bios_uuid");