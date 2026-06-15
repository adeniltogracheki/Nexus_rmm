import { pgTable, uuid, text, timestamp, inet } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { maquinas } from "./machines";
import { usuarios } from "./users";

export const sessoesRemotas = pgTable("sessoes_remotas", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  maquinaId: uuid("maquina_id")
    .notNull()
    .references(() => maquinas.id),
  usuarioId: uuid("usuario_id")
    .notNull()
    .references(() => usuarios.id),
  tipo: text("tipo").notNull(), // "pty" | "tela"
  status: text("status").notNull(),
  ipOrigem: inet("ip_origem"),
  conectadoEm: timestamp("conectado_em", { withTimezone: true }).notNull().defaultNow(),
  encerradoEm: timestamp("encerrado_em", { withTimezone: true }),
});
