import { pgTable, uuid, text, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { maquinas } from "./machines";

// Tarefas agendadas (o servidor é o "cron"; dispara via shell.run). Sem RLS:
// o agendador consulta todos os tenants; as rotas filtram por tenant explicitamente.
export const tarefasAgendadas = pgTable(
  "tarefas_agendadas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    maquinaId: uuid("maquina_id").notNull().references(() => maquinas.id, { onDelete: "cascade" }),
    nome: text("nome").notNull(),
    comando: text("comando").notNull(),
    shell: text("shell").notNull().default("powershell"),
    // "diaria" (todo dia no horario) | "unica" (em dataUnica)
    frequencia: text("frequencia").notNull().default("diaria"),
    horario: text("horario"), // "HH:MM" para diaria
    dataUnica: timestamp("data_unica", { withTimezone: true }),
    ativo: boolean("ativo").notNull().default(true),
    proximaExec: timestamp("proxima_exec", { withTimezone: true }),
    ultimaExec: timestamp("ultima_exec", { withTimezone: true }),
    ultimoStatus: text("ultimo_status"),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_tarefas_proxima").on(t.ativo, t.proximaExec)],
);
