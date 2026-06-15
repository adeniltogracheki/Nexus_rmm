import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";

/**
 * Remediações pendentes de aprovação humana.
 * A IA propõe ações e aguarda resposta via web, Telegram ou WhatsApp.
 */
export const remediacoesAprovacao = pgTable("remediacoes_aprovacao", {
  id:               uuid("id").primaryKey().defaultRandom(),
  tenantId:         uuid("tenant_id").notNull(),
  maquinaId:        uuid("maquina_id").notNull(),
  codigo:           text("codigo").notNull(),              // 6 chars, ex: "ABC123"
  triggerDescricao: text("trigger_descricao").notNull(),
  acoesProposas:    jsonb("acoes_propostas").$type<string[]>().notNull(),
  metricasAntes:    jsonb("metricas_antes"),
  status:           text("status").notNull().default("aguardando"), // aguardando|aprovado|recusado|expirado
  aprovadoPor:      text("aprovado_por"),                 // "web:userId" | "telegram:firstName" | "whatsapp:numero"
  expiresAt:        timestamp("expires_at", { withTimezone: true }).notNull(),
  criadoEm:         timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
});
