import { pgTable, uuid, text, boolean, timestamp, index, pgEnum } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { maquinas } from "./machines";

export const severidadeAlertaEnum = pgEnum("severidade_alerta", ["info", "aviso", "critico"]);

export const alertas = pgTable(
  "alertas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // Máquina relacionada (opcional — alertas gerais não têm máquina).
    maquinaId: uuid("maquina_id").references(() => maquinas.id, { onDelete: "cascade" }),
    tipo: text("tipo").notNull(), // ex.: "offline", "watchdog", "disco"
    severidade: severidadeAlertaEnum("severidade").notNull().default("info"),
    mensagem: text("mensagem").notNull(),
    lida: boolean("lida").notNull().default(false),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_alertas_tenant").on(t.tenantId),
    index("idx_alertas_lida").on(t.tenantId, t.lida),
  ],
);
