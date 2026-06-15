import { pgTable, uuid, integer, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { maquinas } from "./machines";

// Histórico de métricas (amostrado ~a cada 5min) para gráficos de tendência.
export const metricasHistorico = pgTable(
  "metricas_historico",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    maquinaId: uuid("maquina_id").notNull().references(() => maquinas.id, { onDelete: "cascade" }),
    cpu: integer("cpu").notNull(),
    ram: integer("ram").notNull(),
    disco: jsonb("disco").$type<Array<{ caminho: string; usoPct: number }>>(),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_methist_maq_data").on(t.maquinaId, t.criadoEm)],
);
