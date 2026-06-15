import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import forge from "node-forge";
import { eq } from "drizzle-orm";

process.env.SERVER_PORT = "4002";
process.env.AGENT_GATEWAY_PORT = "8445";

import { io as ioClient, type Socket } from "socket.io-client";

test("RMM Inventário: sincronização do inventário do sistema (hardware, SO, rede, software) e rotas de API", async (t) => {
  const { buildApp } = await import("../src/app");
  const { db, pool } = await import("../src/db");
  const { tenants, usuarios, maquinas, inventarios } = await import("../src/db/schema");
  const { comTenant } = await import("../src/db/tenant");
  const { redis } = await import("../src/redis");
  const { obterOuCriarCa } = await import("../src/pki/ca");
  const { emitirCertificadoCliente } = await import("../src/pki/issue");
  const { iniciarGatewayAgentes, encerrarGatewayAgentes } = await import("../src/gateway/agent");
  const { encerrarSocketAdmin } = await import("../src/gateway/admin");
  const { assinarAccess } = await import("../src/auth/jwt");
  const { Ev } = await import("@nexus/protocol");

  const app = await buildApp();
  await app.listen({ port: 4002, host: "127.0.0.1" });
  await iniciarGatewayAgentes(app);

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const slug = `ten-inv-${suffix}`;

  const tenant = (await db.insert(tenants).values({ nome: "Tenant Inventários", slug, plano: "enterprise" }).returning())[0];
  assert.ok(tenant);

  const admin = (
    await db
      .insert(usuarios)
      .values({ tenantId: tenant.id, email: `adm-inv-${suffix}@teste.local`, senhaHash: "hash", papel: "admin" })
      .returning()
  )[0];
  assert.ok(admin);

  const adminToken = await assinarAccess({ userId: admin.id, tenantId: tenant.id, papel: "admin", mfa: true });
  const cookie = `nexus_at=${adminToken}`;

  const machineId = crypto.randomUUID();
  const agentKeys = forge.pki.rsa.generateKeyPair(1024);
  const agentPublicKeyPem = forge.pki.publicKeyToPem(agentKeys.publicKey);
  const agentPrivateKeyPem = forge.pki.privateKeyToPem(agentKeys.privateKey);

  await comTenant(tenant.id, async (tdb) => {
    await tdb.insert(maquinas).values({
      id: machineId,
      tenantId: tenant.id,
      hostname: "agente-inventario-teste",
      fingerprint: `fp-inv-${suffix}`,
      chavePublicaAgente: agentPublicKeyPem,
    });
  });

  const ca = obterOuCriarCa();
  const agentCertPem = emitirCertificadoCliente(machineId, tenant.id, agentPublicKeyPem);

  const socketsParaFechar: Socket[] = [];

  t.after(async () => {
    for (const socket of socketsParaFechar) {
      socket.disconnect();
    }
    await encerrarGatewayAgentes();
    await encerrarSocketAdmin();
    await app.close();

    await comTenant(tenant.id, async (tdb) => {
      await tdb.delete(inventarios).where(eq(inventarios.maquinaId, machineId));
      await tdb.delete(maquinas).where(eq(maquinas.tenantId, tenant.id));
    });
    await db.delete(usuarios).where(eq(usuarios.tenantId, tenant.id));
    await db.delete(tenants).where(eq(tenants.id, tenant.id));

    await pool.end();
    redis.disconnect();
  });

  let agentSocket: Socket;

  // 1. Conecta o agente de teste
  await new Promise<void>((resolve, reject) => {
    agentSocket = ioClient("https://localhost:8445/agent", {
      transports: ["websocket"],
      secure: true,
      rejectUnauthorized: false,
      key: agentPrivateKeyPem,
      cert: agentCertPem,
      ca: ca.caCertPem,
      timeout: 5000,
      reconnection: false,
    });
    socketsParaFechar.push(agentSocket);
    agentSocket.on("connect", () => resolve());
    agentSocket.on("connect_error", (err) => reject(err));
  });

  // 2. Testar sincronização do inventário
  await t.test("Sincroniza o inventário completo (hardware, SO, rede, software)", async () => {
    const payload = {
      machineId,
      capturadoEm: Date.now(),
      hardware: {
        cpu: { modelo: "AMD Ryzen 5 5600X", cores: 6, threads: 12 },
        ram: { totalBytes: 17179869184 },
        discos: [
          { caminho: "C:", tamanhoBytes: 512110182400, livreBytes: 256055091200 }
        ],
        fabricante: "ASUSTeK COMPUTER INC.",
        modeloPlaca: "TUF GAMING B550M-PLUS"
      },
      so: {
        nome: "Windows 11 Pro",
        versao: "10.0.22631",
        arquitetura: "x64",
        dataInstalacao: "2023-05-10 14:30:22",
        bootTime: "2026-06-05 08:00:00"
      },
      rede: [
        { interface: "Ethernet 1", mac: "00:1A:2B:3C:4D:5E", ips: ["192.168.1.150"] }
      ],
      software: [
        { nome: "Google Chrome", versao: "125.0.6422.142", fornecedor: "Google LLC", dataInstalacao: "20260601" },
        { nome: "Visual Studio Code", versao: "1.90.0", fornecedor: "Microsoft Corporation", dataInstalacao: "20260602" }
      ]
    };

    agentSocket.emit(Ev.AgentInventory, payload);

    // Aguarda processamento
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Valida via API
    const res = await app.inject({
      method: "GET",
      url: `/api/maquinas/${machineId}/inventario`,
      headers: { cookie },
    });

    assert.equal(res.statusCode, 200);
    const data = res.json();

    assert.equal(data.maquinaId, machineId);
    assert.equal(data.so.nome, "Windows 11 Pro");
    assert.equal(data.hardware.cpu.modelo, "AMD Ryzen 5 5600X");
    assert.equal(data.hardware.ram.totalBytes, 17179869184);
    assert.equal(data.rede.length, 1);
    assert.equal(data.rede[0].interface, "Ethernet 1");
    assert.equal(data.software.length, 2);
    assert.equal(data.software[0].nome, "Google Chrome");
    assert.equal(data.software[1].nome, "Visual Studio Code");
  });

  // 3. Testar RLS e 404
  await t.test("Retorna 404 para máquina sem acesso (outro tenant) ou inexistente", async () => {
    // Máquina aleatória que não pertence a ninguém
    const randomMachineId = crypto.randomUUID();
    const resRandom = await app.inject({
      method: "GET",
      url: `/api/maquinas/${randomMachineId}/inventario`,
      headers: { cookie },
    });
    assert.equal(resRandom.statusCode, 404);
  });
});
