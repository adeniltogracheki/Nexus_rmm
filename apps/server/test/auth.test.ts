import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { db, pool } from "../src/db";
import { tenants, usuarios } from "../src/db/schema";
import { hashSenha } from "../src/auth/password";
import { redis } from "../src/redis";

test("login: senha correta autentica; errada falha; /me com sessão", async (t) => {
  const slug = `auth-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const email = `${slug}@teste.local`;
  const senha = "Senha#ForteTeste1";

  const tenant = (await db.insert(tenants).values({ nome: "T Auth", slug, plano: "enterprise" }).returning())[0];
  assert.ok(tenant);
  const senhaHash = await hashSenha(senha);
  const user = (
    await db
      .insert(usuarios)
      .values({ tenantId: tenant.id, email, senhaHash, papel: "owner" })
      .returning()
  )[0];
  assert.ok(user);

  const app = await buildApp();

  t.after(async () => {
    await app.close();
    await db.delete(usuarios).where(eq(usuarios.id, user.id));
    await db.delete(tenants).where(eq(tenants.id, tenant.id));
    await pool.end();
    redis.disconnect();
  });

  // senha errada → 401
  const ruim = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, senha: "errada" },
  });
  assert.equal(ruim.statusCode, 401, "senha errada deve falhar");

  // senha certa → 200 + cookie de sessão + precisaConfigurarMfa (sem MFA ainda)
  const ok = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, senha },
  });
  assert.equal(ok.statusCode, 200, "login válido");
  const body = ok.json();
  assert.equal(body.ok, true);
  assert.equal(body.precisaConfigurarMfa, true, "owner novo precisa configurar MFA");
  const cookies = ok.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  assert.match(cookies, /nexus_at=/, "deve setar cookie de access");

  // /me com a sessão
  const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookies } });
  assert.equal(me.statusCode, 200, "/me autenticado");
  assert.equal(me.json().email, email);
});
