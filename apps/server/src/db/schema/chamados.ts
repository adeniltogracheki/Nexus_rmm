import { pgTable, uuid, text, timestamp, index, pgEnum } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { maquinas } from "./machines";
import { usuarios } from "./users";

export const statusChamadoEnum = pgEnum("status_chamado", ["aberto", "em_andamento", "resolvido", "fechado"]);
export const prioridadeChamadoEnum = pgEnum("prioridade_chamado", ["baixa", "media", "alta", "critica"]);

export const chamados = pgTable(
  "chamados",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    // Máquina relacionada (opcional).
    maquinaId: uuid("maquina_id").references(() => maquinas.id, { onDelete: "set null" }),
    titulo: text("titulo").notNull(),
    descricao: text("descricao").notNull(),
    status: statusChamadoEnum("status").notNull().default("aberto"),
    prioridade: prioridadeChamadoEnum("prioridade").notNull().default("media"),
    abertoPor: uuid("aberto_por").notNull().references(() => usuarios.id),
    atribuidoA: uuid("atribuido_a").references(() => usuarios.id),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_chamados_tenant").on(t.tenantId),
    index("idx_chamados_status").on(t.tenantId, t.status),
  ],
);

export const chamadoComentarios = pgTable(
  "chamado_comentarios",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    chamadoId: uuid("chamado_id").notNull().references(() => chamados.id, { onDelete: "cascade" }),
    autorId: uuid("autor_id").notNull().references(() => usuarios.id),
    texto: text("texto").notNull(),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_comentarios_chamado").on(t.chamadoId)],
);
