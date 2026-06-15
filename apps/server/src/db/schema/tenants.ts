import { pgTable, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  nome: text("nome").notNull(),
  slug: text("slug").notNull().unique(),
  ativo: boolean("ativo").notNull().default(true),
  // Plano de assinatura: trial | essencial | pro | enterprise.
  plano: text("plano").notNull().default("trial"),
  // Fim do período de teste (só relevante no plano trial).
  trialExpiraEm: timestamp("trial_expira_em", { withTimezone: true }),
  // Assinatura paga até (renovação mensal). Null = sem assinatura paga vigente.
  pagoAte: timestamp("pago_ate", { withTimezone: true }),
  // Último aviso de vencimento enviado (dedup dos e-mails de cobrança).
  avisoVencimentoEm: timestamp("aviso_vencimento_em", { withTimezone: true }),
  criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
});
