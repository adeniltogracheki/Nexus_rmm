import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import forge from "node-forge";
import { eq } from "drizzle-orm";

// Redefine portas para o ambiente de testes antes de qualquer import do projeto
process.env.SERVER_PORT = "4001";
process.env.AGENT_GATEWAY_PORT = "8444";
process.env.AGENTE_UPDATE_GRACE_SECONDS = "0"; // Testes: sem grace period

import { io as ioClient, type Socket } from "socket.io-client";

test("RMM Gateway: conexões mTLS, batimento de coração e presença multi-tenant", async (t) => {
  // Imports dinâmicos para aplicar process.env de teste antes do carregamento do config
  const { buildApp } = await import("../src/app");
  const { db, pool } = await import("../src/db");
  const { tenants, usuarios, maquinas } = await import("../src/db/schema");
  const { comTenant } = await import("../src/db/tenant");
  const { redis } = await import("../src/redis");
  const { obterOuCriarCa } = await import("../src/pki/ca");
  const { emitirCertificadoCliente } = await import("../src/pki/issue");
  const { iniciarGatewayAgentes, encerrarGatewayAgentes } = await import("../src/gateway/agent");
  const { encerrarSocketAdmin } = await import("../src/gateway/admin");
  const { assinarAccess } = await import("../src/auth/jwt");
  const { Ev } = await import("@nexus/protocol");

  const app = await buildApp();

  
  // Sobe o servidor HTTP na porta 4001
  await app.listen({ port: 4001, host: "127.0.0.1" });
  
  // Sobe o gateway HTTPS de agentes na porta 8444
  await iniciarGatewayAgentes(app);

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const slug1 = `ten-g1-${suffix}`;
  const slug2 = `ten-g2-${suffix}`;

  // Criamos 2 tenants para validar o RLS/Isolamento de presença
  const tenant1 = (await db.insert(tenants).values({ nome: "Tenant Gateway 1", slug: slug1 }).returning())[0];
  const tenant2 = (await db.insert(tenants).values({ nome: "Tenant Gateway 2", slug: slug2 }).returning())[0];
  assert.ok(tenant1);
  assert.ok(tenant2);

  // Criamos usuários admin em ambos os tenants
  const admin1 = (
    await db
      .insert(usuarios)
      .values({ tenantId: tenant1.id, email: `adm1-${suffix}@teste.local`, senhaHash: "hash", papel: "admin" })
      .returning()
  )[0];
  const admin2 = (
    await db
      .insert(usuarios)
      .values({ tenantId: tenant2.id, email: `adm2-${suffix}@teste.local`, senhaHash: "hash", papel: "admin" })
      .returning()
  )[0];
  assert.ok(admin1);
  assert.ok(admin2);

  // JWTs correspondentes
  const adminToken1 = await assinarAccess({ userId: admin1.id, tenantId: tenant1.id, papel: "admin", mfa: true });
  const adminToken2 = await assinarAccess({ userId: admin2.id, tenantId: tenant2.id, papel: "admin", mfa: true });

  // Máquina de teste no Tenant 1
  const machineId = crypto.randomUUID();
  const agentKeys = forge.pki.rsa.generateKeyPair(1024);
  const agentPublicKeyPem = forge.pki.publicKeyToPem(agentKeys.publicKey);
  const agentPrivateKeyPem = forge.pki.privateKeyToPem(agentKeys.privateKey);

  await comTenant(tenant1.id, async (tdb) => {
    await tdb.insert(maquinas).values({
      id: machineId,
      tenantId: tenant1.id,
      hostname: "agente-gateway-teste",
      fingerprint: `fp-${suffix}`,
      chavePublicaAgente: agentPublicKeyPem,
    });
  });

  // Emissão do certificado da máquina de teste
  const ca = obterOuCriarCa();
  const agentCertPem = emitirCertificadoCliente(machineId, tenant1.id, agentPublicKeyPem);

  // Coleção de sockets de clientes para fechar no final
  const socketsParaFechar: Socket[] = [];

  t.after(async () => {
    // Fecha sockets de clientes incondicionalmente
    for (const socket of socketsParaFechar) {
      socket.disconnect();
    }

    // Encerra gateways e servidores
    await encerrarGatewayAgentes();
    await encerrarSocketAdmin();
    await app.close();

    // Limpeza de banco de dados
    await comTenant(tenant1.id, async (tdb) => {
      await tdb.delete(maquinas).where(eq(maquinas.tenantId, tenant1.id));
    });
    await db.delete(usuarios).where(eq(usuarios.tenantId, tenant1.id));
    await db.delete(usuarios).where(eq(usuarios.tenantId, tenant2.id));
    await db.delete(tenants).where(eq(tenants.id, tenant1.id));
    await db.delete(tenants).where(eq(tenants.id, tenant2.id));

    await pool.end();
    redis.disconnect();
  });

  // 1. Validar que conexões sem certificado mTLS falham no handshake
  await t.test("Conexão sem certificado de cliente mTLS deve ser rejeitada", async () => {
    await new Promise<void>((resolve, reject) => {
      const socket = ioClient("https://localhost:8444/agent", {
        transports: ["websocket"],
        secure: true,
        rejectUnauthorized: false, // Ignora o cert autoassinado do servidor
        timeout: 5000,
        reconnection: false,
      });
      socketsParaFechar.push(socket);

      socket.on("connect", () => {
        reject(new Error("Conexão sem certificado de cliente foi indevidamente aceita"));
      });

      socket.on("connect_error", (err) => {
        // Sucesso esperado: erro de TLS ou handshake rejeitado
        assert.ok(err);
        resolve();
      });
    });
  });

  // Sockets que usaremos nos testes seguintes
  let agentSocket: Socket;
  let adminSocket1: Socket;
  let adminSocket2: Socket;

  // 2. Validar conexão mTLS com sucesso
  await t.test("Conexão com certificado legítimo deve ser aceita e registrar presença", async () => {
    // Garantir estado offline inicialmente no DB
    let maq = (await comTenant(tenant1.id, (tdb) => tdb.select().from(maquinas).where(eq(maquinas.id, machineId)).limit(1)))[0];
    assert.equal(maq?.online, false);

    await new Promise<void>((resolve, reject) => {
      agentSocket = ioClient("https://localhost:8444/agent", {
        transports: ["websocket"],
        secure: true,
        rejectUnauthorized: false, // Ignora o cert autoassinado do servidor nos testes
        key: agentPrivateKeyPem,
        cert: agentCertPem,
        ca: ca.caCertPem,
        timeout: 5000,
        reconnection: false,
      });
      socketsParaFechar.push(agentSocket);

      agentSocket.on("connect", () => {
        resolve();
      });

      agentSocket.on("connect_error", (err) => {
        reject(err);
      });
    });

    // Validar status online no Postgres
    maq = (await comTenant(tenant1.id, (tdb) => tdb.select().from(maquinas).where(eq(maquinas.id, machineId)).limit(1)))[0];
    assert.equal(maq?.online, true, "Máquina deve constar como ONLINE no Postgres");

    // Validar presença no Redis
    const presenca = await redis.get(`maquina:${machineId}:online`);
    assert.equal(presenca, "true", "Máquina deve constar como ONLINE no Redis");
  });

  // 3. Validar envio de batimento de coração (Heartbeat)
  await t.test("Envio de batimento de coração (heartbeat) atualiza TTL no Redis", async () => {
    // Diminui TTL artificialmente no Redis para testar renovação
    await redis.set(`maquina:${machineId}:online`, "true", "EX", 10);
    
    agentSocket.emit(Ev.AgentHeartbeat, {
      machineId,
      versaoAgente: "1.0.0",
      uptimeSegundos: 3600,
      enviadoEm: Date.now(),
    });

    // Aguarda um instante para o processamento assíncrono
    await new Promise((resolve) => setTimeout(resolve, 100));

    const ttl = await redis.ttl(`maquina:${machineId}:online`);
    assert.ok(ttl > 10, "Heartbeat deve restabelecer o TTL para próximo de 60 segundos");
  });

  // 3b. Validar auto-update do agente
  await t.test("Agente desatualizado deve receber evento de atualização", async () => {
    let updateDisparado = false;
    let urlRecebida = "";
    let versaoRecebida = "";

    agentSocket.on(Ev.UpdateAvailable, (data: { url: string; version: string }) => {
      updateDisparado = true;
      urlRecebida = data.url;
      versaoRecebida = data.version;
    });

    // Envia heartbeat com versão desatualizada (0.0.9)
    agentSocket.emit(Ev.AgentHeartbeat, {
      machineId,
      versaoAgente: "0.0.9",
      uptimeSegundos: 10,
      enviadoEm: Date.now(),
    });

    // Aguarda processamento do evento
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(updateDisparado, true, "Evento de atualização deveria ter sido disparado");
    assert.ok(urlRecebida.includes("/agente/agent.js"), "URL de atualização inválida");
    const { config } = await import("../src/config");
    assert.equal(versaoRecebida, config.AGENTE_VERSAO_PROD, "Versão de produção enviada incorreta");

    // Remove listener
    agentSocket.off(Ev.UpdateAvailable);
  });

  await t.test("Agente atualizado não deve receber evento de atualização", async () => {
    let updateDisparado = false;

    agentSocket.on(Ev.UpdateAvailable, () => {
      updateDisparado = true;
    });

    // Envia heartbeat com versão atualizada (0.1.0)
    agentSocket.emit(Ev.AgentHeartbeat, {
      machineId,
      versaoAgente: "9.9.9", // versão nova >= prod
      uptimeSegundos: 20,
      enviadoEm: Date.now(),
    });

    // Aguarda processamento
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(updateDisparado, false, "Agente atualizado não deveria receber evento de atualização");

    // Remove listener
    agentSocket.off(Ev.UpdateAvailable);
  });

  // 4. Validar conexão administrativa e retransmissão de presença multi-tenant
  await t.test("Admin recebe eventos de presença de máquinas de seu tenant e não de outros", async () => {
    // 4a. Conecta o Admin 1 (mesmo tenant do agente)
    await new Promise<void>((resolve, reject) => {
      adminSocket1 = ioClient("http://localhost:4001/admin", {
        transports: ["websocket"],
        auth: { token: adminToken1 },
        timeout: 5000,
        reconnection: false,
      });
      socketsParaFechar.push(adminSocket1);
      adminSocket1.on("connect", () => resolve());
      adminSocket1.on("connect_error", (err) => reject(err));
    });

    // 4b. Conecta o Admin 2 (tenant diferente)
    await new Promise<void>((resolve, reject) => {
      adminSocket2 = ioClient("http://localhost:4001/admin", {
        transports: ["websocket"],
        auth: { token: adminToken2 },
        timeout: 5000,
        reconnection: false,
      });
      socketsParaFechar.push(adminSocket2);
      adminSocket2.on("connect", () => resolve());
      adminSocket2.on("connect_error", (err) => reject(err));
    });

    let admin1RecebeuDesconexao = false;
    let admin2RecebeuDesconexao = false;

    adminSocket1.on("admin:machine-presence", (data) => {
      if (data.machineId === machineId && data.online === false) {
        admin1RecebeuDesconexao = true;
      }
    });

    adminSocket2.on("admin:machine-presence", (data) => {
      if (data.machineId === machineId) {
        admin2RecebeuDesconexao = true;
      }
    });

    // 4c. Desconecta o agente (provoca evento offline)
    agentSocket.disconnect();

    // Aguarda processamento do disconnect e Pub/Sub (200ms)
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(admin1RecebeuDesconexao, true, "Admin 1 deve ter recebido a notificação de offline da sua máquina");
    assert.equal(admin2RecebeuDesconexao, false, "Admin 2 NÃO deve ter recebido a notificação (isolamento de tenant)");

    // Validar status offline no Postgres
    const maq = (await comTenant(tenant1.id, (tdb) => tdb.select().from(maquinas).where(eq(maquinas.id, machineId)).limit(1)))[0];
    assert.equal(maq?.online, false, "Máquina deve constar como OFFLINE no Postgres após desconectar");

    // 4d. Reconectar o agente para validar envio de online
    let admin1RecebeuConexao = false;
    adminSocket1.on("admin:machine-presence", (data) => {
      if (data.machineId === machineId && data.online === true) {
        admin1RecebeuConexao = true;
      }
    });

    // Conecta o agente de novo
    await new Promise<void>((resolve) => {
      agentSocket.connect();
      agentSocket.on("connect", () => resolve());
    });

    // Aguarda Pub/Sub
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(admin1RecebeuConexao, true, "Admin 1 deve ter recebido a notificação de online da sua máquina");
  });
});
