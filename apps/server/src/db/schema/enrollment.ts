import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

// Tabela exigida pela §5 do brief (não constava na árvore da §3 — ver README).
export const tokensEnrollment = pgTable(
  "tokens_enrollment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    tokenHash: text("token_hash").notNull(),
    descricao: text("descricao"),
    maxUsos: integer("max_usos").notNull().default(1),
    usos: integer("usos").notNull().default(0),
    expiraEm: timestamp("expira_em", { withTimezone: true }),
    criadoPor: uuid("criado_por"),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_enrollment_tenant").on(t.tenantId)],
);
