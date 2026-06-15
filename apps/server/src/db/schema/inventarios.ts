import { pgTable, uuid, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { maquinas } from "./machines";

export const inventarios = pgTable(
  "inventarios",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    maquinaId: uuid("maquina_id")
      .notNull()
      .unique()
      .references(() => maquinas.id, { onDelete: "cascade" }),
    hardware: jsonb("hardware").notNull(),
    so: jsonb("so").notNull(),
    rede: jsonb("rede").notNull(),
    software: jsonb("software").notNull(),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_inventarios_tenant").on(t.tenantId),
    index("idx_inventarios_maquina").on(t.maquinaId),
  ],
);
