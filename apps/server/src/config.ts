import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SERVER_PORT: z.coerce.number().int().positive().default(4000),
  AGENT_GATEWAY_PORT: z.coerce.number().int().positive().default(8443),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  POSTGRES_SUPER_PASSWORD: z.string().optional(),
  NEXUS_APP_PASSWORD: z.string().optional(),

  // Auth (Fase 1) — obrigatório.
  JWT_SECRET: z.string().min(32, "JWT_SECRET precisa de ao menos 32 caracteres"),
  COMMAND_SIGNING_PRIVATE_KEY: z.string().optional(),

  PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  COOKIE_DOMAIN: z.string().optional(),
  CA_DIR: z.string().default("./secrets"),

  // Tela (acesso não supervisionado): grant efêmero + URL do relay.
  SCREEN_GRANT_SECRET: z.string().min(32, "SCREEN_GRANT_SECRET precisa de 32+ caracteres").optional(),
  TELA_RELAY_URL: z.string().url().default("https://rmm.gmtec.tec.br/spike"),
  // Senha do VNC entregue ao agente SÓ pelo canal mTLS (nunca no instalador público).
  SCREEN_VNC_PASSWORD: z.string().optional(),

  // Versão canônica de produção para auto-update dos agentes
  AGENTE_VERSAO_PROD: z.string().default("0.6.3"),
  // Grace period (s) antes de disparar o evento de auto-update. Em testes pode ser 0.
  AGENTE_UPDATE_GRACE_SECONDS: z.coerce.number().int().min(0).default(60),

  // Seed do owner inicial (db:seed).
  SEED_TENANT_NOME: z.string().default("GMTec"),
  SEED_TENANT_SLUG: z.string().default("gmtec"),
  SEED_OWNER_EMAIL: z.string().email().optional(),
  SEED_OWNER_SENHA: z.string().min(8).optional(),
  // Super admin da plataforma (pode criar contas/tenants de clientes).
  PLATFORM_ADMIN_EMAIL: z.string().default("admin@gmtec.tec.br"),
  // Mercado Pago (cobrança). Token só no ambiente, nunca no código.
  MP_ACCESS_TOKEN: z.string().optional(),
  // Segredo HMAC para validar assinaturas dos webhooks do Mercado Pago.
  // Configurar em: Painel MP → Webhooks → Segredo da assinatura.
  MP_WEBHOOK_SECRET: z.string().optional(),
  APP_URL: z.string().url().default("https://rmm.gmtec.tec.br"),

  // IA — briefing diário (opcional: sem a key o briefing vira texto simples)
  ANTHROPIC_API_KEY: z.string().optional(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error(
    "✗ Configuração de ambiente inválida:\n",
    JSON.stringify(parsed.error.flatten().fieldErrors, null, 2),
  );
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;

// Guardrails de produção — falha rápido antes de aceitar tráfego real.
if (config.NODE_ENV === "production") {
  const erros: string[] = [];
  if (config.JWT_SECRET.length < 64)
    erros.push("JWT_SECRET deve ter ao menos 64 caracteres em produção");
  if (config.SEED_OWNER_SENHA === "NexusAdmin2026!")
    erros.push("SEED_OWNER_SENHA padrão detectada em produção — altere imediatamente");
  if (erros.length > 0) {
    console.error("✗ Guardrails de segurança em produção falharam:\n" + erros.map(e => `  • ${e}`).join("\n"));
    process.exit(1);
  }
}
