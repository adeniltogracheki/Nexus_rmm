import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import forge from "node-forge";
import { eq } from "drizzle-orm";

process.env.SERVER_PORT = "4002";
process.env.AGENT_GATEWAY_PORT = "8445";

import { io as ioClient, type Socket } from "socket.io-client";

test("RMM Serviços: sincronização de inventário, execução de comandos com assinatura e logs de auditoria", async (t) => {
  const { buildApp } = await import("../src/app");
  const { db, pool } = await import("../src/db");
  const { tenants, usuarios, maquinas, servicosWindows, logsServicosWindows } = await import("../src/db/schema");
  const { comTenant } = await import("../src/db/tenant");
  const { redis } = await import("../src/redis");
  const { obterOuCriarCa } = await import("../src/pki/ca");
  const { emitirCertificadoCliente } = await import("../src/pki/issue");
  const { iniciarGatewayAgentes, encerrarGatewayAgentes } = await import("../src/gateway/agent");
  const { encerrarSocketAdmin } = await import("../src/gateway/admin");
  const { assinarAccess } = await import("../src/auth/jwt");
  const { Ev, obterPayloadAssinatura } = await import("@nexus/protocol");

  const app = await buildApp();
  await app.listen({ port: 4002, host: "127.0.0.1" });
  await iniciarGatewayAgentes(app);

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const slug = `ten-srv-${suffix}`;

  const tenant = (await db.insert(tenants).values({ nome: "Tenant Serviços", slug, plano: "enterprise" }).returning())[0];
  assert.ok(tenant);

  const admin = (
    await db
      .insert(usuarios)
      .values({ tenantId: tenant.id, email: `adm-${suffix}@teste.local`, senhaHash: "hash", papel: "admin" })
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
      hostname: "agente-servico-teste",
      fingerprint: `fp-${suffix}`,
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
      await tdb.delete(servicosWindows).where(eq(servicosWindows.maquinaId, machineId));
      await tdb.delete(logsServicosWindows).where(eq(logsServicosWindows.maquinaId, machineId));
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

  // 2. Envia inventário de serviços
  await t.test("Sincroniza inventário de serviços enviado pelo agente", async () => {
    agentSocket.emit(Ev.ServiceInventory, {
      machineId,
      services: [
        { Name: "Spooler", DisplayName: "Print Spooler", Status: "Running", StartType: "Automatic" },
        { Name: "wuauserv", DisplayName: "Windows Update", Status: "Stopped", StartType: "Manual" },
        { Name: "Obsoleto", DisplayName: "Servico Obsoleto", Status: "Stopped", StartType: "Disabled" },
      ],
      enviadoEm: Date.now(),
    });

    // Aguarda inserção
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Valida via API do admin
    const res = await app.inject({
      method: "GET",
      url: `/api/maquinas/${machineId}/servicos`,
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    const lista = res.json();
    assert.equal(lista.length, 3);
    
    const spooler = lista.find((s: any) => s.nome === "Spooler");
    assert.ok(spooler);
    assert.equal(spooler.estado, "Running");
    assert.equal(spooler.tipoInicializacao, "Automatic");
  });

  // 3. Envia inventário delta/segundo inventário (exclui o obsoleto)
  await t.test("Atualiza inventário e remove serviços órfãos", async () => {
    agentSocket.emit(Ev.ServiceInventory, {
      machineId,
      services: [
        { Name: "Spooler", DisplayName: "Print Spooler", Status: "Stopped", StartType: "Automatic" },
        { Name: "wuauserv", DisplayName: "Windows Update", Status: "Running", StartType: "Automatic" },
      ],
      enviadoEm: Date.now(),
    });

    // Aguarda atualização
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Valida
    const res = await app.inject({
      method: "GET",
      url: `/api/maquinas/${machineId}/servicos`,
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    const lista = res.json();
    assert.equal(lista.length, 2); // 'Obsoleto' deve ter sido deletado
    
    const spooler = lista.find((s: any) => s.nome === "Spooler");
    assert.equal(spooler.estado, "Stopped");
  });

  // 4. Executa comando assinado com resposta de sucesso
  await t.test("Executa ação em serviço (STOP) com sucesso, valida assinatura e gera log de auditoria", async () => {
    // Escuta o comando no agente mock
    let comandoRecebido: any = null;
    agentSocket.on("server:command", (cmd) => {
      comandoRecebido = cmd;
      
      // Valida assinatura com a CA no mock do agente
      const { signature, ...cmdWithoutSig } = cmd;
      const canonical = obterPayloadAssinatura(cmdWithoutSig);
      const verify = crypto.createVerify("SHA256");
      verify.update(canonical);
      const signatureValida = verify.verify(ca.caCertPem, signature, "hex");
      
      // Envia resposta de SUCESSO
      agentSocket.emit(Ev.CommandResult, {
        commandId: cmd.commandId,
        status: signatureValida ? "SUCESSO" : "FALHA",
        finishedAt: Date.now(),
      });
    });

    // Dispara a requisição HTTP que chama o gateway
    const res = await app.inject({
      method: "POST",
      url: `/api/maquinas/${machineId}/servicos/wuauserv/acao`,
      headers: { cookie },
      payload: { action: "STOP" },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().sucesso, true);

    // Valida se o comando foi recebido
    assert.ok(comandoRecebido);
    assert.equal(comandoRecebido.service, "wuauserv");
    assert.equal(comandoRecebido.action, "STOP");

    // Valida se o log de auditoria foi gravado e possui hashes
    const logs = await comTenant(tenant.id, (tdb) =>
      tdb.select().from(logsServicosWindows).where(eq(logsServicosWindows.maquinaId, machineId))
    );
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.servicoNome, "wuauserv");
    assert.equal(logs[0]?.acaoExecutada, "STOP");
    assert.equal(logs[0]?.statusResultado, "SUCESSO");
    assert.ok(logs[0]?.hashRegistro, "Hash de registro deve ter sido calculado pelo trigger");
  });
});
