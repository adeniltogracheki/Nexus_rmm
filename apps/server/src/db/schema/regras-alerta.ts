import { pgTable, uuid, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

// Uma linha por tenant — thresholds de alerta e permissão global de IA.
export const regrasAlerta = pgTable("regras_alerta", {
  tenantId:           uuid("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }),
  cpuLimitePct:       integer("cpu_limite_pct").notNull().default(90),
  cpuJanelaMin:       integer("cpu_janela_min").notNull().default(2),
  ramLimitePct:       integer("ram_limite_pct").notNull().default(90),
  ramJanelaMin:       integer("ram_janela_min").notNull().default(2),
  discoLivreMinPct:   integer("disco_livre_min_pct").notNull().default(10),
  offlineToleranciaMin: integer("offline_tolerancia_min").notNull().default(5),
  iaRemediaCaoGlobal: boolean("ia_remediacão_global").notNull().default(false),
  criadoEm:           timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
});
