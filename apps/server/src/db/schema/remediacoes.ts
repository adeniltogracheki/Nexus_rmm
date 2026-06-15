import { pgTable, uuid, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { maquinas } from "./machines";

export const remediacoesIa = pgTable(
  "remediacoes_ia",
  {
    id:                uuid("id").primaryKey().defaultRandom(),
    tenantId:          uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    maquinaId:         uuid("maquina_id").notNull().references(() => maquinas.id, { onDelete: "cascade" }),
    triggerDescricao:  text("trigger_descricao").notNull(),
    acoesExecutadas:   jsonb("acoes_executadas").$type<Array<{ acao: string; cmd: string; output: string; ok: boolean; ms: number }>>(),
    metricasAntes:     jsonb("metricas_antes").$type<{ cpu: number; ram: number; discos?: Array<{ caminho: string; usoPct: number }> }>(),
    metricasDepois:    jsonb("metricas_depois").$type<{ cpu: number; ram: number; discos?: Array<{ caminho: string; usoPct: number }> }>(),
    // executando | concluido | falhou | cancelado
    status:            text("status").notNull().default("executando"),
    iaModelo:          text("ia_modelo"),
    duracaoMs:         integer("duracao_ms"),
    criadoEm:          timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_remediacoes_tenant").on(t.tenantId, t.criadoEm),
    index("idx_remediacoes_maquina").on(t.maquinaId),
  ],
);
