import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { config } from "../config";

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
// .../apps/server/src/db -> .../apps/server/drizzle
const drizzleDir = resolve(__dirname, "../../drizzle");

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  const db = drizzle(pool);

  try {
    console.log("→ aplicando migrations geradas...");
    await migrate(db, { migrationsFolder: drizzleDir });

    console.log("→ aplicando hardening (RLS + cadeia de hash + REVOKE)...");
    const hardening = await readFile(resolve(drizzleDir, "zzz_hardening.sql"), "utf8");
    await pool.query(hardening);

    console.log("✓ migrate + hardening concluídos.");
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error("✗ migrate falhou:", err);
  process.exit(1);
});
