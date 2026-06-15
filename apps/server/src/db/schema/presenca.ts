import { pgTable, uuid, boolean, timestamp, index } from "drizzle-orm/pg-core";

// Log append-only de transições de presença (online/offline) por máquina.
// Base para cálculo de disponibilidade (uptime/SLA).
export const presencaLog = pgTable(
  "presenca_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    maquinaId: uuid("maquina_id").notNull(),
    online: boolean("online").notNull(),
    em: timestamp("em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_presenca_maquina_em").on(t.maquinaId, t.em)],
);
