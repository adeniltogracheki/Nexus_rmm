import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { maquinas } from "./machines";
import { usuarios } from "./users";

// Auditoria append-only. hash_anterior/hash_registro são preenchidos pelo
// trigger BEFORE INSERT (ver drizzle/zzz_hardening.sql). NUNCA UPDATE/DELETE.
export const logsServicosWindows = pgTable(
  "logs_servicos_windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    usuarioId: uuid("usuario_id").references(() => usuarios.id),
    maquinaId: uuid("maquina_id")
      .notNull()
      .references(() => maquinas.id),
    servicoNome: text("servico_nome").notNull(),
    acaoExecutada: text("acao_executada").notNull(),
    tipoInicializacaoAnterior: text("tipo_inicializacao_anterior"),
    statusResultado: text("status_resultado").notNull(),
    detalhesErro: text("detalhes_erro"),
    hashAnterior: text("hash_anterior"),
    hashRegistro: text("hash_registro"),
    executadoEm: timestamp("executado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_logs_maquina").on(t.maquinaId),
    index("idx_logs_usuario").on(t.usuarioId),
  ],
);
