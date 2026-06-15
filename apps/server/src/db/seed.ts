import { eq } from "drizzle-orm";
import { db, pool } from "./index";
import { tenants, usuarios } from "./schema";
import { hashSenha } from "../auth/password";
import { config } from "../config";

async function main(): Promise<void> {
  if (!config.SEED_OWNER_EMAIL || !config.SEED_OWNER_SENHA) {
    console.error("✗ Defina SEED_OWNER_EMAIL e SEED_OWNER_SENHA no .env para rodar o seed.");
    process.exit(1);
  }

  let tenant = (
    await db.select().from(tenants).where(eq(tenants.slug, config.SEED_TENANT_SLUG)).limit(1)
  )[0];
  if (!tenant) {
    tenant = (
      await db
        .insert(tenants)
        .values({ nome: config.SEED_TENANT_NOME, slug: config.SEED_TENANT_SLUG })
        .returning()
    )[0];
    console.log("✓ tenant criado:", tenant?.slug);
  } else {
    console.log("• tenant já existe:", tenant.slug);
  }
  if (!tenant) throw new Error("falha ao criar/obter tenant");

  const existente = (
    await db.select().from(usuarios).where(eq(usuarios.email, config.SEED_OWNER_EMAIL)).limit(1)
  )[0];
  if (existente) {
    console.log("• owner já existe:", existente.email);
  } else {
    const senhaHash = await hashSenha(config.SEED_OWNER_SENHA);
    const u = (
      await db
        .insert(usuarios)
        .values({ tenantId: tenant.id, email: config.SEED_OWNER_EMAIL, senhaHash, papel: "owner" })
        .returning()
    )[0];
    console.log("✓ owner criado:", u?.email, "(configure o MFA no primeiro login)");
  }

  await pool.end();
}

main().catch((err: unknown) => {
  console.error("✗ seed falhou:", err);
  process.exit(1);
});
