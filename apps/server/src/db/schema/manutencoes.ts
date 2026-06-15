import { pgTable, uuid, text, timestamp, index, integer } from "drizzle-orm/pg-core";

// Histórico de manutenções por máquina (ciclo de vida do ativo).
export const manutencoes = pgTable(
  "manutencoes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    maquinaId: uuid("maquina_id").notNull(),
    // preventiva | corretiva | melhoria | instalacao
    tipo: text("tipo").notNull().default("corretiva"),
    descricao: text("descricao").notNull(),
    pecasTrocadas: text("pecas_trocadas"),
    tecnico: text("tecnico"),
    custo: text("custo"),
    statusManut: text("status_manut").notNull().default("concluida"), // aberta | em_andamento | concluida
    dataManutencao: timestamp("data_manutencao", { withTimezone: true }).notNull().defaultNow(),
    proximaPreventiva: timestamp("proxima_preventiva", { withTimezone: true }),
    // Marca quando já gerou alerta de preventiva vencida (evita duplicar).
    alertadoEm: timestamp("alertado_em", { withTimezone: true }),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_manutencoes_maquina").on(t.maquinaId, t.dataManutencao)],
);

// Anexos da manutenção (foto da peça, nota fiscal). Dados em base64.
export const manutencaoAnexos = pgTable(
  "manutencao_anexos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    manutencaoId: uuid("manutencao_id").notNull(),
    nome: text("nome").notNull(),
    tipo: text("tipo").notNull(), // mime
    tamanho: integer("tamanho").notNull().default(0),
    dados: text("dados").notNull(), // base64
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_anexos_manut").on(t.manutencaoId)],
);
