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
  AGENTE_VERSAO_PROD: z.string().default("0.1.0"),

  // Seed do owner inicial (db:seed).
  SEED_TENANT_NOME: z.string().default("GMTec"),
  SEED_TENANT_SLUG: z.string().default("gmtec"),
  SEED_OWNER_EMAIL: z.string().email().optional(),
  SEED_OWNER_SENHA: z.string().min(8).optional(),
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
