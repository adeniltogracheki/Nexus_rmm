import { pgTable, uuid, text, timestamp, index, pgEnum, foreignKey } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

// Empresa = grupo de topo; Departamento = subgrupo (parentId aponta para a empresa).
export const tipoGrupoEnum = pgEnum("tipo_grupo", ["empresa", "departamento"]);

export const grupos = pgTable(
  "grupos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    nome: text("nome").notNull(),
    tipo: tipoGrupoEnum("tipo").notNull().default("empresa"),
    parentId: uuid("parent_id"),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_grupos_tenant").on(t.tenantId),
    foreignKey({ columns: [t.parentId], foreignColumns: [t.id], name: "fk_grupos_parent" }).onDelete(
      "set null",
    ),
  ],
);
