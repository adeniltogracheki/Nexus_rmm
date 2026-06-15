import { pgTable, uuid, text, boolean, timestamp, index, unique } from "drizzle-orm/pg-core";
import { maquinas } from "./machines";

// Escopada por máquina (e, via máquina, por tenant). Sem tenant_id direto.
export const servicosWindows = pgTable(
  "servicos_windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    maquinaId: uuid("maquina_id")
      .notNull()
      .references(() => maquinas.id, { onDelete: "cascade" }),
    nome: text("nome").notNull(),
    displayName: text("display_name"),
    estado: text("estado").notNull(),
    tipoInicializacao: text("tipo_inicializacao").notNull(),
    categoria: text("categoria").notNull().default("outro"),
    watchdogAtivo: boolean("watchdog_ativo").notNull().default(false),
    atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_servico_por_maquina").on(t.maquinaId, t.nome),
    index("idx_servicos_maquina").on(t.maquinaId),
  ],
);
