import { eq } from "drizzle-orm";
import { db, pool } from "./index";
import { tenants, usuarios } from "./schema";
import { hashSenha } from "../auth/password";
import { config } from "../config";

// Reseta (ou cria) o owner com senha conhecida e MFA limpo, para o primeiro login
// limpo (o usuário configura o próprio MFA via QR). Credenciais via env:
// RESET_OWNER_EMAIL e RESET_OWNER_SENHA.
async function main(): Promise<void> {
  const email = process.env.RESET_OWNER_EMAIL;
  const senha = process.env.RESET_OWNER_SENHA;
  if (!email || !senha) {
    console.error("✗ defina RESET_OWNER_EMAIL e RESET_OWNER_SENHA no ambiente.");
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
  }
  if (!tenant) throw new Error("falha ao obter/criar tenant");

  const senhaHash = await hashSenha(senha);
  const existe = (
    await db.select().from(usuarios).where(eq(usuarios.email, email)).limit(1)
  )[0];

  if (existe) {
    await db
      .update(usuarios)
      .set({ senhaHash, mfaSecret: null, ativo: true, papel: "owner" })
      .where(eq(usuarios.id, existe.id));
    console.log("✓ owner resetado:", email, "(senha trocada, MFA limpo p/ reconfigurar no 1º login)");
  } else {
    await db
      .insert(usuarios)
      .values({ tenantId: tenant.id, email, senhaHash, papel: "owner" });
    console.log("✓ owner criado:", email);
  }

  await pool.end();
}

main().catch((err: unknown) => {
  console.error("✗ reset-owner falhou:", err);
  process.exit(1);
});
