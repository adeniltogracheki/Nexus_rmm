import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";

// Config GLOBAL de segurança (1 linha, id fixo "global"). Editada pelo owner/admin no painel.
export const configSeguranca = pgTable("config_seguranca", {
  id: text("id").primaryKey().default("global"),
  apenasBrasil: boolean("apenas_brasil").notNull().default(false),
  forcar2fa: boolean("forcar_2fa").notNull().default(false),
  nomeMarca: text("nome_marca"),
  logoUrl: text("logo_url"),
  atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
});
