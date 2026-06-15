import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { pool } from "./index";
import * as schema from "./schema";

export type TenantDB = NodePgDatabase<typeof schema>;

/**
 * Executa `fn` numa conexão com `app.tenant_id` setado, ativando o RLS das
 * tabelas de dados (maquinas, tokens_enrollment, sessoes_remotas, logs). Sempre libera.
 */
export async function comTenant<T>(
  tenantId: string,
  fn: (db: TenantDB) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId]);
    const tdb = drizzle(client, { schema });
    return await fn(tdb);
  } finally {
    await client.query("SELECT set_config('app.tenant_id', '', false)").catch(() => {});
    client.release();
  }
}
