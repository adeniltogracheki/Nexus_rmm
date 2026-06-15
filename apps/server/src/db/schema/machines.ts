import { pgTable, uuid, text, boolean, timestamp, index, pgEnum, jsonb, doublePrecision, real } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { grupos } from "./grupos";

export const tipoMaquinaEnum = pgEnum("tipo_maquina", ["pc", "notebook", "servidor", "mobile", "tablet"]);

export const maquinas = pgTable(
  "maquinas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // Departamento/empresa ao qual a máquina pertence (opcional).
    grupoId: uuid("grupo_id").references(() => grupos.id, { onDelete: "set null" }),
    tipoMaquina: tipoMaquinaEnum("tipo_maquina").notNull().default("pc"),
    // Nome amigável definido pelo admin (ex.: "Notebook do João — Financeiro").
    apelido: text("apelido"),
    hostname: text("hostname").notNull(),
    fingerprint: text("fingerprint").notNull().unique(),
    chavePublicaAgente: text("chave_publica_agente"),
    soVersao: text("so_versao"),
    versaoAgente: text("versao_agente"),
    tags: text("tags").array(),
    responsavel: text("responsavel"),
    online: boolean("online").notNull().default(false),
    vistoEm: timestamp("visto_em", { withTimezone: true }),
    biosUuid: text("bios_uuid"),
    // Soft-delete: máquina arquivada some das listagens mas preserva a auditoria imutável.
    arquivada: boolean("arquivada").notNull().default(false),
    arquivadaEm: timestamp("arquivada_em", { withTimezone: true }),
    // Criticidade da máquina: operacional | importante | critico | missao_critica
    criticidade: text("criticidade").notNull().default("operacional"),
    // IA Remediação: habilitada por máquina + lista de ações permitidas do catálogo
    iaRemediacao: boolean("ia_remediacão_ativa").notNull().default(false),
    iaAcoesPermitidas: jsonb("ia_acoes_permitidas").$type<string[]>(),
    // Wake-on-LAN + tipo de dispositivo
    macAddress: text("mac_address"),
    ipPublico: text("ip_publico"),
    // Localização GPS/rede — preenchido apenas por agentes móveis (Android/tablet)
    latitude:       doublePrecision("latitude"),
    longitude:      doublePrecision("longitude"),
    precisaoMetros: real("precisao_metros"),
    localizacaoEm:  timestamp("localizacao_em", { withTimezone: true }),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_maquinas_tenant").on(t.tenantId),
    index("idx_maquinas_grupo").on(t.grupoId),
    index("idx_maquinas_tenant_bios").on(t.tenantId, t.biosUuid),
  ],
);
