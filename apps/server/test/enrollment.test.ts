import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import forge from "node-forge";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { db, pool } from "../src/db";
import { tenants, usuarios, maquinas, tokensEnrollment } from "../src/db/schema";
import { hashSenha } from "../src/auth/password";
import { redis } from "../src/redis";
import { config } from "../src/config";
import { obterOuCriarCa } from "../src/pki/ca";
import { emitirCertificadoCliente } from "../src/pki/issue";
import { comTenant } from "../src/db/tenant";

test("PKI & Enrollment: CA, emissão de certs, rotas de token e cadastro", async (t) => {
  const app = await buildApp();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const slug = `ten-${suffix}`;
  const email = `admin-${suffix}@teste.local`;
  const senha = "Senha#ForteTeste1";

  // Criação de massa de testes
  const tenant = (await db.insert(tenants).values({ nome: "Tenant Teste mTLS", slug, plano: "enterprise" }).returning())[0];
  assert.ok(tenant);
  
  const senhaHash = await hashSenha(senha);
  const user = (
    await db
      .insert(usuarios)
      .values({ tenantId: tenant.id, email, senhaHash, papel: "admin" })
      .returning()
  )[0];
  assert.ok(user);

  // Limpeza de testes
  t.after(async () => {
    await app.close();
    
    // Deleta os registros criados (em ordem inversa das foreign keys)
    await comTenant(tenant.id, async (tdb) => {
      await tdb.delete(maquinas).where(eq(maquinas.tenantId, tenant.id));
      await tdb.delete(tokensEnrollment).where(eq(tokensEnrollment.tenantId, tenant.id));
    });
    await db.delete(usuarios).where(eq(usuarios.id, user.id));
    await db.delete(tenants).where(eq(tenants.id, tenant.id));
    
    await pool.end();
    redis.disconnect();
  });

  // 1. Validar CA interna
  let ca: ReturnType<typeof obterOuCriarCa>;
  await t.test("obterOuCriarCa gera chaves e arquivos se ausentes", () => {
    ca = obterOuCriarCa();
    assert.ok(ca.caKeyPem, "CA key PEM não pode ser vazia");
    assert.ok(ca.caCertPem, "CA cert PEM não pode ser vazia");
    assert.ok(ca.caKey, "Chave privada da CA em objeto node-forge ausente");
    assert.ok(ca.caCert, "Certificado da CA em objeto node-forge ausente");

    const caDir = path.resolve(config.CA_DIR);
    assert.ok(fs.existsSync(path.join(caDir, "ca.key")), "Arquivo ca.key deve existir");
    assert.ok(fs.existsSync(path.join(caDir, "ca.crt")), "Arquivo ca.crt deve existir");
  });

  // Chaves de teste para o Agente (1024 bits para velocidade)
  const agentKeys = forge.pki.rsa.generateKeyPair(1024);
  const agentPublicKeyPem = forge.pki.publicKeyToPem(agentKeys.publicKey);

  // 2. Validar emissão do certificado
  let certClientePem: string;
  const machineId = crypto.randomUUID();
  await t.test("emitirCertificadoCliente gera cert X.509 assinado", () => {
    certClientePem = emitirCertificadoCliente(machineId, tenant.id, agentPublicKeyPem);
    assert.ok(certClientePem, "Certificado gerado não pode ser vazio");
    assert.match(certClientePem, /BEGIN CERTIFICATE/, "Deve ser formato PEM");

    const cert = forge.pki.certificateFromPem(certClientePem);
    const cn = cert.subject.getField("CN");
    const o = cert.subject.getField("O");
    assert.equal(cn?.value, machineId, "CN deve conter o machineId");
    assert.equal(o?.value, tenant.id, "O deve conter o tenantId");
  });

  // Sessão do admin
  let authCookie = "";
  await t.test("login admin para obter cookie de sessão", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, senha },
    });
    assert.equal(res.statusCode, 200);
    authCookie = res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    assert.match(authCookie, /nexus_at=/, "Access token cookie deve estar presente");
  });

  // 3. Validar criação de tokens de enrollment
  let tokenEnrollment = "";
  await t.test("POST /api/enroll-tokens gera token para o admin autenticado", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/enroll-tokens",
      headers: { cookie: authCookie },
      payload: {
        descricao: "Token de Teste RMM",
        maxUsos: 2,
        expiraEmHoras: 1,
      },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.ok(body.token, "O token deve ser retornado");
    assert.match(body.token, new RegExp(`^${tenant.id}\\.`), "O token deve ter formato tenantId.secret");
    assert.equal(body.maxUsos, 2);
    assert.equal(body.usos, 0);

    tokenEnrollment = body.token;
  });

  // 4. Validar rota de cadastro (/enroll) com sucesso
  let cadastradoMachineId = "";
  await t.test("POST /api/enroll realiza cadastro e emite mTLS", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/enroll",
      payload: {
        token: tokenEnrollment,
        hostname: "pc-desenvolvimento-mtls",
        chavePublicaPem: agentPublicKeyPem,
        soVersao: "Windows 11 Pro",
        versaoAgente: "1.0.0",
      },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.ok(body.machineId, "machineId retornado");
    assert.ok(body.certificadoClientePem, "certificado de cliente retornado");
    assert.ok(body.certificadoCaPem, "certificado da CA retornado");
    assert.equal(body.certificadoCaPem, ca.caCertPem, "Certificado da CA deve bater com a CA interna");

    cadastradoMachineId = body.machineId;

    // Verificar se está no banco
    const [maq] = await comTenant(tenant.id, async (tdb) => {
      return tdb.select().from(maquinas).where(eq(maquinas.id, cadastradoMachineId)).limit(1);
    });
    assert.ok(maq, "Máquina deve estar no banco de dados");
    assert.equal(maq.hostname, "pc-desenvolvimento-mtls");
    assert.equal(maq.tenantId, tenant.id);
  });

  // 4b. Validar rota de listagem de maquinas (/maquinas)
  await t.test("GET /api/maquinas retorna a lista de máquinas sob o tenant", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/maquinas",
      headers: { cookie: authCookie },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body), "Deve retornar um array");
    const maqEncontrada = body.find((m: any) => m.id === cadastradoMachineId);
    assert.ok(maqEncontrada, "A máquina cadastrada deve estar na listagem");
    assert.equal(maqEncontrada.hostname, "pc-desenvolvimento-mtls");
  });

  // 5. Validar controle de limite de usos do token
  await t.test("POST /api/enroll com o mesmo token (segundo uso)", async () => {
    const outroKeys = forge.pki.rsa.generateKeyPair(1024);
    const outroPublicKeyPem = forge.pki.publicKeyToPem(outroKeys.publicKey);

    const res = await app.inject({
      method: "POST",
      url: "/api/enroll",
      payload: {
        token: tokenEnrollment,
        hostname: "pc-segundo-uso",
        chavePublicaPem: outroPublicKeyPem,
      },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.ok(body.machineId);
  });

  await t.test("POST /api/enroll com o mesmo token (limite de uso de 2 excedido)", async () => {
    const outroKeys = forge.pki.rsa.generateKeyPair(1024);
    const outroPublicKeyPem = forge.pki.publicKeyToPem(outroKeys.publicKey);

    const res = await app.inject({
      method: "POST",
      url: "/api/enroll",
      payload: {
        token: tokenEnrollment,
        hostname: "pc-terceiro-uso",
        chavePublicaPem: outroPublicKeyPem,
      },
    });

    assert.equal(res.statusCode, 401, "Deve falhar por limite de usos esgotado");
  });

  // 6. Validar erro de chave duplicada (fingerprint)
  await t.test("POST /api/enroll com chave publica duplicada deve retornar 409", async () => {
    // Gerar outro token
    const tokenRes = await app.inject({
      method: "POST",
      url: "/api/enroll-tokens",
      headers: { cookie: authCookie },
      payload: { maxUsos: 1 },
    });
    const outroToken = tokenRes.json().token;

    const res = await app.inject({
      method: "POST",
      url: "/api/enroll",
      payload: {
        token: outroToken,
        hostname: "pc-duplicado",
        chavePublicaPem: agentPublicKeyPem, // Chave já usada no primeiro teste
      },
    });

    assert.equal(res.statusCode, 409, "Deve rejeitar por chave pública (fingerprint) duplicada");
  });

  // 7. Validar erro de token inexistente ou malformado
  await t.test("POST /api/enroll com token malformado ou inexistente deve retornar 401", async () => {
    const keys = forge.pki.rsa.generateKeyPair(1024);
    const pubKey = forge.pki.publicKeyToPem(keys.publicKey);

    // Malformado (sem ponto)
    const res1 = await app.inject({
      method: "POST",
      url: "/api/enroll",
      payload: {
        token: "tokensemseparador",
        hostname: "pc-errado",
        chavePublicaPem: pubKey,
      },
    });
    assert.equal(res1.statusCode, 401);

    // Tenant UUID inválido
    const res2 = await app.inject({
      method: "POST",
      url: "/api/enroll",
      payload: {
        token: "invalido-uuid.secreto",
        hostname: "pc-errado",
        chavePublicaPem: pubKey,
      },
    });
    assert.equal(res2.statusCode, 401);

    // Inexistente mas com formato correto
    const fakeTenant = crypto.randomUUID();
    const fakeSecret = crypto.randomBytes(32).toString("hex");
    const res3 = await app.inject({
      method: "POST",
      url: "/api/enroll",
      payload: {
        token: `${fakeTenant}.${fakeSecret}`,
        hostname: "pc-errado",
        chavePublicaPem: pubKey,
      },
    });
    assert.equal(res3.statusCode, 401);
  });

  // 8. Validar re-cadastro (re-enrollment) via biosUuid
  await t.test("POST /api/enroll com biosUuid existente deve reutilizar machineId e atualizar dados", async () => {
    // Gerar outro token
    const tokenRes = await app.inject({
      method: "POST",
      url: "/api/enroll-tokens",
      headers: { cookie: authCookie },
      payload: { maxUsos: 5 },
    });
    const tokenRe = tokenRes.json().token;

    const testBiosUuid = "550e8400-e29b-41d4-a716-446655440000";
    const keypair1 = forge.pki.rsa.generateKeyPair(1024);
    const pubKey1 = forge.pki.publicKeyToPem(keypair1.publicKey);

    // Primeiro cadastro
    const res1 = await app.inject({
      method: "POST",
      url: "/api/enroll",
      payload: {
        token: tokenRe,
        hostname: "pc-bios-primeiro",
        chavePublicaPem: pubKey1,
        biosUuid: testBiosUuid,
      },
    });
    assert.equal(res1.statusCode, 201);
    const body1 = res1.json();
    const firstMachineId = body1.machineId;
    assert.ok(firstMachineId);

    // Segundo cadastro (simulando re-instalação após formatação, novas chaves, mesmo biosUuid)
    const keypair2 = forge.pki.rsa.generateKeyPair(1024);
    const pubKey2 = forge.pki.publicKeyToPem(keypair2.publicKey);

    const res2 = await app.inject({
      method: "POST",
      url: "/api/enroll",
      payload: {
        token: tokenRe,
        hostname: "pc-bios-reinstalado",
        chavePublicaPem: pubKey2,
        biosUuid: testBiosUuid,
      },
    });
    assert.equal(res2.statusCode, 200, "Re-enrollment deve retornar HTTP 200");
    const body2 = res2.json();
    assert.equal(body2.machineId, firstMachineId, "machineId deve ser reaproveitado");

    // Verificar se no banco as informações foram atualizadas
    const [maq] = await comTenant(tenant.id, async (tdb) => {
      return tdb.select().from(maquinas).where(eq(maquinas.id, firstMachineId)).limit(1);
    });
    assert.ok(maq);
    assert.equal(maq.hostname, "pc-bios-reinstalado", "Hostname deve ter sido atualizado");
    assert.equal(maq.chavePublicaAgente, pubKey2, "Chave pública do agente deve ter sido atualizada");
  });

  // 9. Validar que biosUuid genérico NÃO causa re-enrollment
  await t.test("POST /api/enroll com biosUuid genérico deve gerar nova máquina", async () => {
    // Gerar outro token
    const tokenRes = await app.inject({
      method: "POST",
      url: "/api/enroll-tokens",
      headers: { cookie: authCookie },
      payload: { maxUsos: 5 },
    });
    const tokenRe = tokenRes.json().token;

    const genericBiosUuid = "00000000-0000-0000-0000-000000000000";
    
    // Primeiro cadastro com UUID genérico
    const keypair1 = forge.pki.rsa.generateKeyPair(1024);
    const pubKey1 = forge.pki.publicKeyToPem(keypair1.publicKey);
    const res1 = await app.inject({
      method: "POST",
      url: "/api/enroll",
      payload: {
        token: tokenRe,
        hostname: "pc-generic-1",
        chavePublicaPem: pubKey1,
        biosUuid: genericBiosUuid,
      },
    });
    assert.equal(res1.statusCode, 201);
    const id1 = res1.json().machineId;

    // Segundo cadastro com mesmo UUID genérico mas chaves novas
    const keypair2 = forge.pki.rsa.generateKeyPair(1024);
    const pubKey2 = forge.pki.publicKeyToPem(keypair2.publicKey);
    const res2 = await app.inject({
      method: "POST",
      url: "/api/enroll",
      payload: {
        token: tokenRe,
        hostname: "pc-generic-2",
        chavePublicaPem: pubKey2,
        biosUuid: genericBiosUuid,
      },
    });
    assert.equal(res2.statusCode, 201, "Deve criar máquina nova");
    const id2 = res2.json().machineId;
    assert.notEqual(id1, id2, "Máquinas com UUID da BIOS genérico não devem compartilhar o mesmo machineId");
  });
});
