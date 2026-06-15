import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { comTenant } from "../db/tenant";
import { maquinas, servicosWindows, logsServicosWindows } from "../db/schema";
import { obterOuCriarCa } from "../pki/ca";
import { enviarComandoAgente } from "../gateway/agent";
import { requireEscopoMaquina } from "../escopo";
import { requirePermissao } from "../permissoes";
import { requirePlano } from "../plano-guard";
import { ServiceActionCommand, obterPayloadAssinatura } from "@nexus/protocol";

/** A máquina pertence ao tenant? (anti-IDOR: nunca mandar comando sem confirmar a posse.) */
async function maquinaDoTenant(tenantId: string, id: string): Promise<boolean> {
  const r = await comTenant(tenantId, (tdb) =>
    tdb.select({ id: maquinas.id }).from(maquinas).where(eq(maquinas.id, id)).limit(1),
  );
  return r.length > 0;
}

const AcaoServicoRequest = z.object({
  action: z.enum(["START", "STOP", "RESTART", "CHANGE_TYPE"]),
  startupType: z.enum(["Automatic", "Manual", "Disabled"]).optional(),
});

const AcaoEmMassaRequest = z.object({
  maquinaIds: z.array(z.string().uuid()).min(1).max(200),
  service: z.string().min(1),
  action: z.enum(["START", "STOP", "RESTART", "CHANGE_TYPE"]),
  startupType: z.enum(["Automatic", "Manual", "Disabled"]).optional(),
});

const WatchdogRequest = z.object({ enabled: z.boolean() });

const ShellRunRequest = z.object({
  command: z.string().min(1).max(8000),
  shell: z.enum(["powershell", "cmd"]).default("powershell"),
});

/**
 * Assina, despacha (mTLS) e audita uma ação de serviço numa máquina.
 * Reaproveitado pela ação individual e pela ação em massa.
 */
async function despacharAcaoServico(
  tenantId: string,
  userId: string,
  machineId: string,
  service: string,
  action: "START" | "STOP" | "RESTART" | "CHANGE_TYPE",
  startupType?: "Automatic" | "Manual" | "Disabled",
  tipoInicializacaoAnterior: string | null = null,
): Promise<{ statusResultado: "SUCESSO" | "FALHA"; detalhesErro: string | null }> {
  const { caKeyPem } = obterOuCriarCa();
  const commandId = crypto.randomUUID();
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 60_000;

  const commandPayload = {
    commandId,
    machineId,
    issuedAt,
    expiresAt,
    type: "service.action" as const,
    service,
    action,
    startupType,
  };
  const canonicalPayload = obterPayloadAssinatura(commandPayload as any);
  const sign = crypto.createSign("SHA256");
  sign.update(canonicalPayload);
  const signature = sign.sign(caKeyPem, "hex");
  const fullCommand = { ...commandPayload, signature };

  let statusResultado: "SUCESSO" | "FALHA" = "SUCESSO";
  let detalhesErro: string | null = null;
  try {
    const result = await enviarComandoAgente(machineId, fullCommand as any);
    if (result.status === "FALHA") {
      statusResultado = "FALHA";
      detalhesErro = result.error || "Erro desconhecido retornado pelo agente";
    }
  } catch (err: any) {
    statusResultado = "FALHA";
    detalhesErro = err.message || "Timeout ou falha na entrega do comando";
  }

  await comTenant(tenantId, async (tdb) => {
    await tdb.insert(logsServicosWindows).values({
      tenantId,
      usuarioId: userId,
      maquinaId: machineId,
      servicoNome: service,
      acaoExecutada: action === "CHANGE_TYPE" ? `CHANGE_TYPE (${startupType})` : action,
      tipoInicializacaoAnterior,
      statusResultado,
      detalhesErro,
    });
  });

  return { statusResultado, detalhesErro };
}

export const servicosRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/maquinas/:id/servicos
  app.get(
    "/api/maquinas/:id/servicos",
    { preHandler: [app.requireAuth, requirePlano("servicos"), requireEscopoMaquina] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { tenantId } = req.auth!;

      try {
        const servicos = await comTenant(tenantId, async (tdb) => {
          // Verifica se a máquina existe no tenant (RLS garante isolamento)
          const m = await tdb
            .select()
            .from(maquinas)
            .where(eq(maquinas.id, id))
            .limit(1);

          if (m.length === 0) {
            return null;
          }

          // Busca todos os serviços da máquina
          return tdb
            .select()
            .from(servicosWindows)
            .where(eq(servicosWindows.maquinaId, id));
        });

        if (servicos === null) {
          return reply.code(404).send({ erro: "máquina não encontrada ou sem acesso" });
        }

        return reply.send(servicos);
      } catch (err) {
        app.log.error({ err, tenantId, machineId: id }, "Erro ao listar serviços da máquina");
        return reply.code(500).send({ erro: "erro interno ao listar serviços" });
      }
    }
  );

  // POST /api/maquinas/:id/servicos/:nome/acao
  app.post(
    "/api/maquinas/:id/servicos/:nome/acao",
    { preHandler: [app.requireAuth, app.requireMfa, app.requireOperador, requirePermissao("servicos"), requirePlano("servicos"), requireEscopoMaquina] },
    async (req, reply) => {
      const { id, nome } = req.params as { id: string; nome: string };
      const { tenantId, userId } = req.auth!;

      const parsed = AcaoServicoRequest.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ erro: "dados de ação inválidos", detalhes: parsed.error.flatten() });
      }

      const { action, startupType } = parsed.data;

      try {
        // 1. Validar máquina e obter estado anterior do serviço dentro do tenant
        const serviceState = await comTenant(tenantId, async (tdb) => {
          const m = await tdb
            .select()
            .from(maquinas)
            .where(eq(maquinas.id, id))
            .limit(1);

          if (m.length === 0) {
            return { erro: "máquina não encontrada ou sem acesso" as const };
          }

          // Verifica se o serviço está cadastrado no banco para obtermos o tipoInicializacaoAnterior
          const s = await tdb
            .select()
            .from(servicosWindows)
            .where(and(eq(servicosWindows.maquinaId, id), eq(servicosWindows.nome, nome)))
            .limit(1);

          return {
            tipoInicializacaoAnterior: s[0]?.tipoInicializacao || null,
          };
        });

        if ("erro" in serviceState) {
          return reply.code(404).send({ erro: serviceState.erro });
        }

        // 2. Criar e assinar o envelope do comando
        const { caKeyPem } = obterOuCriarCa();
        const commandId = crypto.randomUUID();
        const issuedAt = Date.now();
        const expiresAt = issuedAt + 60_000; // Validade de 60 segundos

        const commandPayload = {
          commandId,
          machineId: id,
          issuedAt,
          expiresAt,
          type: "service.action" as const,
          service: nome,
          action,
          startupType,
        };

        const canonicalPayload = obterPayloadAssinatura(commandPayload as any);
        const sign = crypto.createSign("SHA256");
        sign.update(canonicalPayload);
        const signature = sign.sign(caKeyPem, "hex");

        const fullCommand = {
          ...commandPayload,
          signature,
        };

        let statusResultado: "SUCESSO" | "FALHA" = "SUCESSO";
        let detalhesErro: string | null = null;

        // 3. Enviar o comando para o agente e aguardar resultado
        try {
          const result = await enviarComandoAgente(id, fullCommand as any);
          if (result.status === "FALHA") {
            statusResultado = "FALHA";
            detalhesErro = result.error || "Erro desconhecido retornado pelo agente";
          }
        } catch (err: any) {
          statusResultado = "FALHA";
          detalhesErro = err.message || "Timeout ou falha na entrega do comando";
        }

        // 4. Gravar na auditoria imutável (logsServicosWindows)
        await comTenant(tenantId, async (tdb) => {
          await tdb.insert(logsServicosWindows).values({
            tenantId,
            usuarioId: userId,
            maquinaId: id,
            servicoNome: nome,
            acaoExecutada: action === "CHANGE_TYPE" ? `CHANGE_TYPE (${startupType})` : action,
            tipoInicializacaoAnterior: serviceState.tipoInicializacaoAnterior,
            statusResultado,
            detalhesErro,
          });
        });

        if (statusResultado === "FALHA") {
          return reply.code(502).send({ erro: "ação falhou no agente", detalhes: detalhesErro });
        }

        return reply.send({ sucesso: true });
      } catch (err) {
        app.log.error({ err, tenantId, machineId: id, service: nome }, "Erro ao executar ação no serviço");
        return reply.code(500).send({ erro: "erro interno ao executar ação" });
      }
    }
  );

  // POST /api/servicos/acao-em-massa — aplica a MESMA ação de serviço em várias máquinas.
  app.post(
    "/api/servicos/acao-em-massa",
    { preHandler: [app.requireAuth, app.requireMfa, app.requireOperador, requirePermissao("servicos"), requirePlano("servicos"), requireEscopoMaquina] },
    async (req, reply) => {
      const { tenantId, userId } = req.auth!;
      const parsed = AcaoEmMassaRequest.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ erro: "dados inválidos", detalhes: parsed.error.flatten() });
      }
      const { maquinaIds, service, action, startupType } = parsed.data;

      // Só age em máquinas do próprio tenant e não arquivadas (RLS + filtro).
      const validas = await comTenant(tenantId, async (tdb) => {
        const rows = await tdb
          .select({ id: maquinas.id })
          .from(maquinas)
          .where(eq(maquinas.arquivada, false));
        return new Set(rows.map((r) => r.id));
      });
      const alvo = maquinaIds.filter((id) => validas.has(id));
      if (alvo.length === 0) {
        return reply.code(404).send({ erro: "nenhuma máquina válida selecionada" });
      }

      const resultados = await Promise.all(
        alvo.map(async (id) => {
          const r = await despacharAcaoServico(tenantId, userId, id, service, action, startupType);
          return { maquinaId: id, ...r };
        }),
      );
      const sucesso = resultados.filter((r) => r.statusResultado === "SUCESSO").length;
      return reply.send({
        total: resultados.length,
        sucesso,
        falha: resultados.length - sucesso,
        resultados,
      });
    },
  );

  // POST /api/maquinas/:id/servicos/:nome/watchdog — liga/desliga self-healing do serviço.
  app.post(
    "/api/maquinas/:id/servicos/:nome/watchdog",
    { preHandler: [app.requireAuth, app.requireMfa, app.requireOperador, requirePermissao("servicos"), requirePlano("servicos"), requireEscopoMaquina] },
    async (req, reply) => {
      const { id, nome } = req.params as { id: string; nome: string };
      const { tenantId, userId } = req.auth!;
      const parsed = WatchdogRequest.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ erro: "dados inválidos" });
      }
      const { enabled } = parsed.data;

      if (!(await maquinaDoTenant(tenantId, id))) return reply.code(404).send({ erro: "máquina não encontrada" });

      const { caKeyPem } = obterOuCriarCa();
      const commandId = crypto.randomUUID();
      const issuedAt = Date.now();
      const commandPayload = {
        commandId,
        machineId: id,
        issuedAt,
        expiresAt: issuedAt + 60_000,
        type: "service.set-watchdog" as const,
        service: nome,
        enabled,
      };
      const canonical = obterPayloadAssinatura(commandPayload as any);
      const sign = crypto.createSign("SHA256");
      sign.update(canonical);
      const signature = sign.sign(caKeyPem, "hex");

      let statusResultado: "SUCESSO" | "FALHA" = "SUCESSO";
      let detalhesErro: string | null = null;
      try {
        const result = await enviarComandoAgente(id, { ...commandPayload, signature } as any);
        if (result.status === "FALHA") {
          statusResultado = "FALHA";
          detalhesErro = result.error || "Erro retornado pelo agente";
        }
      } catch (err: any) {
        statusResultado = "FALHA";
        detalhesErro = err.message || "Timeout ou falha na entrega do comando";
      }

      await comTenant(tenantId, async (tdb) => {
        if (statusResultado === "SUCESSO") {
          await tdb
            .update(servicosWindows)
            .set({ watchdogAtivo: enabled })
            .where(and(eq(servicosWindows.maquinaId, id), eq(servicosWindows.nome, nome)));
        }
        await tdb.insert(logsServicosWindows).values({
          tenantId,
          usuarioId: userId,
          maquinaId: id,
          servicoNome: nome,
          acaoExecutada: `WATCHDOG ${enabled ? "ON" : "OFF"}`,
          statusResultado,
          detalhesErro,
        });
      });

      if (statusResultado === "FALHA") {
        return reply.code(502).send({ erro: "falha no agente", detalhes: detalhesErro });
      }
      return reply.send({ ok: true, watchdogAtivo: enabled });
    },
  );

  // POST /api/maquinas/:id/shell — Terminal de comandos: roda 1 comando e retorna a saída.
  app.post(
    "/api/maquinas/:id/shell",
    { preHandler: [app.requireAuth, app.requireMfa, app.requireOperador, requirePermissao("servicos"), requirePlano("servicos"), requireEscopoMaquina] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { tenantId, userId } = req.auth!;
      const parsed = ShellRunRequest.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ erro: "comando inválido" });
      }
      const { command, shell } = parsed.data;

      if (!(await maquinaDoTenant(tenantId, id))) return reply.code(404).send({ erro: "máquina não encontrada" });

      const { caKeyPem } = obterOuCriarCa();
      const commandId = crypto.randomUUID();
      const issuedAt = Date.now();
      const commandPayload = {
        commandId,
        machineId: id,
        issuedAt,
        expiresAt: issuedAt + 90_000,
        type: "shell.run" as const,
        shell,
        command,
      };
      const canonical = obterPayloadAssinatura(commandPayload as any);
      const sign = crypto.createSign("SHA256");
      sign.update(canonical);
      const signature = sign.sign(caKeyPem, "hex");

      let statusResultado: "SUCESSO" | "FALHA" = "SUCESSO";
      let detalhesErro: string | null = null;
      let output = "";
      try {
        const result = await enviarComandoAgente(id, { ...commandPayload, signature } as any);
        output = (result as any).output || "";
        if (result.status === "FALHA") {
          statusResultado = "FALHA";
          detalhesErro = result.error || "Erro retornado pelo agente";
        }
      } catch (err: any) {
        statusResultado = "FALHA";
        detalhesErro = err.message || "Timeout ou falha na entrega do comando";
      }

      // Auditoria imutável (comando truncado).
      await comTenant(tenantId, async (tdb) => {
        await tdb.insert(logsServicosWindows).values({
          tenantId,
          usuarioId: userId,
          maquinaId: id,
          servicoNome: "SHELL",
          acaoExecutada: `${shell}: ${command.slice(0, 400)}`,
          statusResultado,
          detalhesErro,
        });
      });

      return reply.send({ status: statusResultado, output, erro: detalhesErro });
    },
  );

  // POST /api/maquinas/:id/desinstalar — desinstala um programa pelo nome (ex.: suspeita de malware).
  app.post(
    "/api/maquinas/:id/desinstalar",
    { preHandler: [app.requireAuth, app.requireMfa, app.requireOperador, requirePermissao("servicos"), requirePlano("servicos"), requireEscopoMaquina] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { tenantId, userId } = req.auth!;
      const parsed = z.object({ displayName: z.string().min(1).max(400) }).safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ erro: "nome inválido" });
      if (!(await maquinaDoTenant(tenantId, id))) return reply.code(404).send({ erro: "máquina não encontrada" });
      const displayName = parsed.data.displayName;
      const nomeEsc = displayName.replace(/'/g, "''");

      // Script PowerShell: acha o desinstalador no registro e roda silencioso (MSI: /quiet).
      const comando = [
        `$nome = '${nomeEsc}'`,
        `$apps = Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq $nome }`,
        `if (-not $apps) { Write-Output "Programa nao encontrado: $nome"; return }`,
        `foreach ($a in $apps) {`,
        `  $u = $a.QuietUninstallString; if (-not $u) { $u = $a.UninstallString }`,
        `  if (-not $u) { Write-Output ("Sem desinstalador para " + $a.DisplayName); continue }`,
        `  Write-Output ("Desinstalando: " + $a.DisplayName)`,
        `  try {`,
        `    $g = [regex]::Match($u, '\\{[0-9A-Fa-f\\-]+\\}').Value`,
        `    if (($u -match 'msiexec') -and $g) { Start-Process msiexec.exe -ArgumentList ('/x ' + $g + ' /quiet /norestart') -Wait -NoNewWindow }`,
        `    else { Start-Process cmd.exe -ArgumentList '/c', $u -Wait -NoNewWindow }`,
        `    Write-Output "Concluido."`,
        `  } catch { Write-Output ("Falha: " + $_.Exception.Message) }`,
        `}`,
      ].join("\n");

      const { caKeyPem } = obterOuCriarCa();
      const commandId = crypto.randomUUID();
      const issuedAt = Date.now();
      const commandPayload = {
        commandId,
        machineId: id,
        issuedAt,
        expiresAt: issuedAt + 120_000,
        type: "shell.run" as const,
        shell: "powershell" as const,
        command: comando,
      };
      const canonical = obterPayloadAssinatura(commandPayload as any);
      const sign = crypto.createSign("SHA256");
      sign.update(canonical);
      const signature = sign.sign(caKeyPem, "hex");

      let statusResultado: "SUCESSO" | "FALHA" = "SUCESSO";
      let detalhesErro: string | null = null;
      let output = "";
      try {
        const result = await enviarComandoAgente(id, { ...commandPayload, signature } as any);
        output = (result as any).output || "";
        if (result.status === "FALHA") {
          statusResultado = "FALHA";
          detalhesErro = result.error || "Erro retornado pelo agente";
        }
      } catch (err: any) {
        statusResultado = "FALHA";
        detalhesErro = err.message || "Timeout ou falha na entrega do comando";
      }

      await comTenant(tenantId, async (tdb) => {
        await tdb.insert(logsServicosWindows).values({
          tenantId,
          usuarioId: userId,
          maquinaId: id,
          servicoNome: "DESINSTALAR",
          acaoExecutada: `Desinstalar: ${displayName.slice(0, 380)}`,
          statusResultado,
          detalhesErro,
        });
      });

      return reply.send({ status: statusResultado, output, erro: detalhesErro });
    },
  );
};
