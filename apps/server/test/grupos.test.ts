import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { db, pool } from "../src/db";
import { tenants, usuarios, grupos, maquinas } from "../src/db/schema";
import { comTenant } from "../src/db/tenant";
import { hashSenha } from "../src/auth/password";
import { assinarAccess } from "../src/auth/jwt";
import { redis } from "../src/redis";

test("grupos: empresa → departamento + atribuir máquina (PC/servidor)", async (t) => {
  const slug = `grp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const tenant = (await db.insert(tenants).values({ nome: "T Grupos", slug }).returning())[0];
  assert.ok(tenant);
  const user = (
    await db
      .insert(usuarios)
      .values({ tenantId: tenant.id, email: `${slug}@t.local`, senhaHash: await hashSenha("xyz12345"), papel: "owner" })
      .returning()
  )[0];
  assert.ok(user);
  const maq = await comTenant(tenant.id, async (tdb) =>
    (await tdb.insert(maquinas).values({ tenantId: tenant.id, hostname: "pc-1", fingerprint: `fp-${slug}` }).returning())[0],
  );
  assert.ok(maq);

  // sessão com MFA satisfeito (token assinado direto)
  const at = await assinarAccess({ userId: user.id, tenantId: tenant.id, papel: "owner", mfa: true });
  const cookie = `nexus_at=${at}`;
  const app = await buildApp();

  t.after(async () => {
    await app.close();
    await comTenant(tenant.id, async (tdb) => {
      await tdb.delete(maquinas).where(eq(maquinas.tenantId, tenant.id));
      await tdb.delete(grupos).where(eq(grupos.tenantId, tenant.id));
    });
    await db.delete(usuarios).where(eq(usuarios.id, user.id));
    await db.delete(tenants).where(eq(tenants.id, tenant.id));
    await pool.end();
    redis.disconnect();
  });

  // cria empresa
  const empRes = await app.inject({ method: "POST", url: "/api/grupos", headers: { cookie }, payload: { nome: "Empresa X", tipo: "empresa" } });
  assert.equal(empRes.statusCode, 201, "cria empresa");
  const empresa = empRes.json();

  // departamento sem parent → 400
  const ruim = await app.inject({ method: "POST", url: "/api/grupos", headers: { cookie }, payload: { nome: "Solto", tipo: "departamento" } });
  assert.equal(ruim.statusCode, 400, "departamento exige empresa");

  // cria departamento sob a empresa
  const depRes = await app.inject({ method: "POST", url: "/api/grupos", headers: { cookie }, payload: { nome: "TI", tipo: "departamento", parentId: empresa.id } });
  assert.equal(depRes.statusCode, 201, "cria departamento");
  const dep = depRes.json();
  assert.equal(dep.parentId, empresa.id, "departamento aponta para a empresa");

  // atribui máquina ao departamento como SERVIDOR
  const atrib = await app.inject({ method: "POST", url: `/api/maquinas/${maq.id}/grupo`, headers: { cookie }, payload: { grupoId: dep.id, tipoMaquina: "servidor" } });
  assert.equal(atrib.statusCode, 200, "atribui máquina");

  // lista grupos (2 no tenant)
  const lista = await app.inject({ method: "GET", url: "/api/grupos", headers: { cookie } });
  assert.equal(lista.statusCode, 200);
  assert.equal(lista.json().length, 2, "2 grupos no tenant");

  // confirma persistência da máquina
  const mRow = await comTenant(tenant.id, async (tdb) =>
    (await tdb.select().from(maquinas).where(eq(maquinas.id, maq.id)).limit(1))[0],
  );
  assert.equal(mRow?.grupoId, dep.id, "máquina no departamento");
  assert.equal(mRow?.tipoMaquina, "servidor", "máquina marcada como servidor");
});
