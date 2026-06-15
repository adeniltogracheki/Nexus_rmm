import { pgTable, uuid, text, boolean, timestamp, pgEnum, unique, jsonb } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

export const papelEnum = pgEnum("papel", ["owner", "admin", "operator", "viewer", "cliente"]);

export const usuarios = pgTable(
  "usuarios",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    email: text("email").notNull(),
    // argon2id é aplicado na app (Fase 1); aqui só a coluna.
    senhaHash: text("senha_hash").notNull(),
    papel: papelEnum("papel").notNull().default("viewer"),
    mfaSecret: text("mfa_secret"),
    // Segredo em configuração (ainda não confirmado). Vira mfaSecret só após o verify.
    mfaPendente: text("mfa_pendente"),
    ativo: boolean("ativo").notNull().default(true),
    // Escopo por empresa (ids de grupos raiz). null = acesso a todas as empresas.
    empresasPermitidas: jsonb("empresas_permitidas").$type<string[] | null>(),
    // Permissões granulares (capabilities). null = padrão do papel.
    permissoes: jsonb("permissoes").$type<string[] | null>(),
    ultimoLogin: timestamp("ultimo_login", { withTimezone: true }),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("uq_usuarios_tenant_email").on(t.tenantId, t.email)],
);
