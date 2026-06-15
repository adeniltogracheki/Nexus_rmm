import { pgTable, uuid, text, boolean, timestamp, integer } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

// Uma config por tenant (tenant_id é a PK).
export const notificacoesConfig = pgTable("notificacoes_config", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id),
  webhookUrl: text("webhook_url"),
  // "generico" (JSON), "slack" (Slack/Discord {text}), "telegram" (sendMessage)
  formato: text("formato").notNull().default("generico"),
  telegramChatId: text("telegram_chat_id"),
  // severidade mínima para notificar: info | aviso | critico
  minSeveridade: text("min_severidade").notNull().default("aviso"),
  ativo: boolean("ativo").notNull().default(false),
  // Relatório semanal automático (via webhook).
  relatorioSemanal: boolean("relatorio_semanal").notNull().default(false),
  relatorioUltimoEnvio: timestamp("relatorio_ultimo_envio", { withTimezone: true }),
  // E-mail (SMTP) por tenant.
  emailAtivo: boolean("email_ativo").notNull().default(false),
  smtpHost: text("smtp_host"),
  smtpPort: integer("smtp_port"),
  smtpSeguro: boolean("smtp_seguro").notNull().default(true),
  smtpUser: text("smtp_user"),
  smtpPass: text("smtp_pass"),
  smtpFrom: text("smtp_from"),
  emailDestinatarios: text("email_destinatarios"), // separados por vírgula
  // Telegram Bot nativo (alternativa ao webhook genérico)
  telegramAtivo: boolean("telegram_ativo").notNull().default(false),
  telegramBotToken: text("telegram_bot_token"),
  telegramChatIdBot: text("telegram_chat_id_bot"),
  // Toggles por tipo de alerta
  notifCritico: boolean("notif_critico").notNull().default(true),
  notifAviso: boolean("notif_aviso").notNull().default(false),
  notifOffline: boolean("notif_offline").notNull().default(true),
  // Webhook secret (usado no Telegram para validação X-Telegram-Bot-Api-Secret-Token)
  telegramWebhookSecret: text("telegram_webhook_secret"),
  // IA remediação ativa para este tenant (feature gate adicional)
  iaRemediacacaoAtiva: boolean("ia_remediacao_ativa").notNull().default(false),
});
