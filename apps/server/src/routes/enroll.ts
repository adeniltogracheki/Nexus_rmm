import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { eq, and, isNull, sql } from "drizzle-orm";
import { EnrollRequest, CriarTokenEnrollmentRequest } from "@nexus/protocol";
import { db } from "../db";
import { tokensEnrollment, maquinas, logsServicosWindows } from "../db/schema";
import { comTenant } from "../db/tenant";
import { emitirCertificadoCliente } from "../pki/issue";
import { obterOuCriarCa } from "../pki/ca";
import { temRestricao, mapaEmpresaRaiz } from "../escopo";
import { redis } from "../redis";
import { tenants } from "../db/schema";
import { planoDe } from "../planos";
import { acessoInfo } from "../plano-guard";
import { calcularHealthScores } from "../lib/health-score";
import { config } from "../config";

// Helper simples para validar UUID v4
function validarUuid(uuid: string): boolean {
  const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return regex.test(uuid);
}

export const enrollRoutes: FastifyPluginAsync = async (app) => {
  
  /**
   * POST /api/enroll
   * Rota pública utilizada pelo instalador do agente para se cadastrar
   */
  app.post("/api/enroll", async (req, reply) => {
    const parsed = EnrollRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ erro: "dados de cadastro inválidos", detalhes: parsed.error.flatten() });
    }

    const { token, hostname, chavePublicaPem, soVersao, versaoAgente, biosUuid } = parsed.data;

    // Token deve ser estruturado no formato: tenantId.secreto
    const partes = token.split(".");
    if (partes.length !== 2) {
      return reply.code(401).send({ erro: "token de cadastro inválido ou malformado" });
    }

    const [tenantId, secret] = partes;

    if (!tenantId || !secret || !validarUuid(tenantId)) {
      return reply.code(401).send({ erro: "token de cadastro inválido ou malformado" });
    }

    const tokenHash = crypto.createHash("sha256").update(secret).digest("hex");
    const fingerprint = crypto.createHash("sha256").update(chavePublicaPem).digest("hex");

    const isGenericUuid = (uuid?: string): boolean => {
      if (!uuid) return true;
      const clean = uuid.trim().toLowerCase();
      return (
        clean === "unknown" ||
        /^(0{8}-0{4}-0{4}-0{4}-0{12}|f{8}-f{4}-f{4}-f{4}-f{12})$/.test(clean)
      );
    };

    try {
      // 1. Validar e processar o token de enrollment dentro do RLS do tenant correspondente
      const tokenValido = await comTenant(tenantId, async (tdb) => {
        const rows = await tdb
          .select()
          .from(tokensEnrollment)
          .where(eq(tokensEnrollment.tokenHash, tokenHash))
          .limit(1);
        const t = rows[0];

        if (!t) {
          return null;
        }

        // Verifica expiração
        if (t.expiraEm && new Date() > new Date(t.expiraEm)) {
          return null;
        }

        // Verifica limite de usos
        if (t.usos >= t.maxUsos) {
          return null;
        }

        // Incrementa o número de usos
        await tdb
          .update(tokensEnrollment)
          .set({ usos: t.usos + 1 })
          .where(eq(tokensEnrollment.id, t.id));

        return t;
      });

      if (!tokenValido) {
        return reply.code(401).send({ erro: "token expirado, exausto ou inválido" });
      }

      let machineId: string | null = null;
      let isReEnroll = false;

      // 2. Se biosUuid válido for informado, tentar localizar a máquina já existente no tenant
      if (biosUuid && !isGenericUuid(biosUuid)) {
        const maquinaPorBios = await comTenant(tenantId, async (tdb) => {
          const rows = await tdb
            .select()
            .from(maquinas)
            .where(eq(maquinas.biosUuid, biosUuid.trim()))
            .limit(1);
          return rows[0];
        });

        if (maquinaPorBios) {
          machineId = maquinaPorBios.id;
          isReEnroll = true;
        }
      }

      // 2b. Heurística de migração: se não achou por biosUuid, tentar por hostname (case-insensitive)
      // para máquinas legadas com biosUuid nulo. Previne duplicatas quando Windows muda caixa do hostname.
      if (!isReEnroll) {
        const maquinaPorHostname = await comTenant(tenantId, async (tdb) => {
          const rows = await tdb
            .select()
            .from(maquinas)
            .where(
              and(
                sql`lower(${maquinas.hostname}) = lower(${hostname})`,
                isNull(maquinas.biosUuid)
              )
            )
            .limit(1);
          return rows[0];
        });

        if (maquinaPorHostname) {
          machineId = maquinaPorHostname.id;
          isReEnroll = true;
        }
      }

      // 3. Se não for re-enrollment, verificar se a máquina já está cadastrada com este fingerprint (evitar duplicar chaves)
      if (!isReEnroll) {
        const maquinaExistente = await comTenant(tenantId, async (tdb) => {
          const rows = await tdb
            .select()
            .from(maquinas)
            .where(eq(maquinas.fingerprint, fingerprint))
            .limit(1);
          return rows[0];
        });

        if (maquinaExistente) {
          return reply.code(409).send({ erro: "máquina com esta chave pública já está cadastrada" });
        }
      }

      // 4. Cadastrar ou atualizar a máquina
      if (isReEnroll && machineId) {
        await comTenant(tenantId, async (tdb) => {
          await tdb
            .update(maquinas)
            .set({
              hostname,
              fingerprint,
              chavePublicaAgente: chavePublicaPem,
              soVersao: soVersao || null,
              versaoAgente: versaoAgente || null,
              biosUuid: biosUuid && !isGenericUuid(biosUuid) ? biosUuid.trim() : undefined,
              // Reinstalar/reconectar desarquiva a máquina (reaproveita o registro).
              arquivada: false,
              arquivadaEm: null,
            })
            .where(eq(maquinas.id, machineId!));
        });
      } else {
        // Acesso suspenso (trial/assinatura vencidos): bloqueia nova máquina.
        const acc = await acessoInfo(tenantId);
        if (acc.bloqueado) {
          return reply.code(402).send({ erro: "Acesso suspenso (teste/assinatura vencidos). Assine ou renove para adicionar máquinas." });
        }
        // Limite do plano: bloqueia NOVA máquina ao atingir o teto.
        const tnt = (await db.select({ plano: tenants.plano }).from(tenants).where(eq(tenants.id, tenantId)).limit(1))[0];
        const max = planoDe(tnt?.plano).maxMaquinas;
        const ativas = await comTenant(tenantId, (tdb) => tdb.select({ id: maquinas.id }).from(maquinas).where(eq(maquinas.arquivada, false)));
        if (ativas.length >= max) {
          return reply.code(402).send({ erro: `Limite do plano atingido (${max} máquinas). Faça upgrade para adicionar mais.` });
        }
        machineId = crypto.randomUUID();
        await comTenant(tenantId, async (tdb) => {
          await tdb.insert(maquinas).values({
            id: machineId!,
            tenantId,
            hostname,
            fingerprint,
            chavePublicaAgente: chavePublicaPem,
            soVersao: soVersao || null,
            versaoAgente: versaoAgente || null,
            biosUuid: biosUuid && !isGenericUuid(biosUuid) ? biosUuid.trim() : null,
          });
        });
      }

      // 5. Emitir certificado de cliente mTLS
      const certificadoClientePem = emitirCertificadoCliente(machineId!, tenantId, chavePublicaPem);
      const { caCertPem } = obterOuCriarCa();

      return reply.code(isReEnroll ? 200 : 201).send({
        machineId: machineId!,
        certificadoClientePem,
        certificadoCaPem: caCertPem,
      });

    } catch (err) {
      app.log.error({ err }, "Erro durante o processamento do enrollment");
      return reply.code(500).send({ erro: "erro interno ao processar cadastro" });
    }
  });

  /**
   * POST /api/enroll-tokens
   * Rota autenticada do administrador para gerar tokens de homologação
   */
  app.post("/api/enroll-tokens", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const parsed = CriarTokenEnrollmentRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ erro: "dados inválidos", detalhes: parsed.error.flatten() });
    }

    const { descricao, maxUsos, expiraEmHoras } = parsed.data;
    const { tenantId, userId } = req.auth!;

    const secret = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(secret).digest("hex");

    let expiraEm: Date | null = null;
    if (expiraEmHoras) {
      expiraEm = new Date();
      expiraEm.setHours(expiraEm.getHours() + expiraEmHoras);
    }

    try {
      const tokenCriado = await comTenant(tenantId, async (tdb) => {
        const [row] = await tdb.insert(tokensEnrollment).values({
          tenantId,
          tokenHash,
          descricao: descricao || null,
          maxUsos,
          usos: 0,
          expiraEm,
          criadoPor: userId,
        }).returning();
        return row;
      });

      if (!tokenCriado) {
        return reply.code(500).send({ erro: "não foi possível criar o token" });
      }

      // O token retornado em texto claro contém: tenantId.secreto
      const tokenCompleto = `${tenantId}.${secret}`;

      return reply.code(201).send({
        id: tokenCriado.id,
        token: tokenCompleto,
        descricao: tokenCriado.descricao,
        maxUsos: tokenCriado.maxUsos,
        usos: tokenCriado.usos,
        expiraEm: tokenCriado.expiraEm,
        criadoEm: tokenCriado.criadoEm,
      });

    } catch (err) {
      app.log.error({ err }, "Erro ao criar token de enrollment");
      return reply.code(500).send({ erro: "erro interno ao gerar token" });
    }
  });

  /**
   * GET /api/maquinas
   * Rota autenticada do administrador para listar as máquinas de seu tenant
   */
  app.get("/api/maquinas", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { tenantId } = req.auth!;
    try {
      let rows = await comTenant(tenantId, async (tdb) => {
        return tdb.select().from(maquinas).where(eq(maquinas.arquivada, false));
      });
      // Escopo por empresa: usuário restrito só vê máquinas das empresas dele.
      if (temRestricao(req.auth)) {
        const raiz = await mapaEmpresaRaiz(tenantId);
        const permitidas = new Set(req.auth!.empresas as string[]);
        rows = rows.filter((m) => m.grupoId && permitidas.has(raiz.get(m.grupoId) || ""));
      }

      // Enriquece com última métrica (cpu/ram) do Redis + nível de saúde + health score.
      let enriquecidas: any[] = rows;
      try {
        const pipe = redis.pipeline();
        rows.forEach((m) => pipe.lindex(`maquina:${m.id}:metricas`, 0));
        const res = await pipe.exec();
        enriquecidas = rows.map((m, i) => {
          let cpu: number | null = null, ram: number | null = null;
          try {
            const s = res?.[i]?.[1] as string | null;
            if (s) { const p = JSON.parse(s); cpu = typeof p.cpu === "number" ? Math.round(p.cpu) : null; ram = typeof p.ram === "number" ? Math.round(p.ram) : null; }
          } catch {}
          let saude: "ok" | "alerta" | "critico" | "offline" = "offline";
          if (m.online) {
            const mx = Math.max(cpu ?? 0, ram ?? 0);
            saude = mx >= 90 ? "critico" : mx >= 75 ? "alerta" : "ok";
          }
          return { ...m, cpu, ram, saude };
        });
      } catch {
        enriquecidas = rows.map((m) => ({ ...m, cpu: null, ram: null, saude: m.online ? "ok" : "offline" }));
      }

      // Enriquece com health score (batch, uma query por tenant).
      try {
        const maquinasParaScore = rows.map((m) => ({ id: m.id, online: m.online }));
        const scoresMap = await comTenant(tenantId, (tdb) =>
          calcularHealthScores(tdb, tenantId, maquinasParaScore),
        );
        enriquecidas = enriquecidas.map((m) => {
          const s = scoresMap.get(m.id);
          return {
            ...m,
            healthScore: s?.score ?? null,
            tendenciaScore: s?.tendencia ?? null,
          };
        });
      } catch {
        enriquecidas = enriquecidas.map((m) => ({ ...m, healthScore: null, tendenciaScore: null }));
      }

      return reply.send(enriquecidas);
    } catch (err) {
      app.log.error({ err, tenantId }, "Erro ao listar máquinas no DB");
      return reply.code(500).send({ erro: "erro interno ao listar máquinas" });
    }
  });

  /**
   * DELETE /api/maquinas/:id
   * Remove (arquiva) a máquina — soft-delete. A auditoria imutável é preservada;
   * a máquina some das listagens. Reinstalar o agente reaproveita o registro.
   */
  app.delete(
    "/api/maquinas/:id",
    { preHandler: [app.requireAuth, app.requireMfa] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { tenantId, userId } = req.auth!;
      try {
        const ok = await comTenant(tenantId, async (tdb) => {
          const alvo = (
            await tdb.select().from(maquinas).where(eq(maquinas.id, id)).limit(1)
          )[0];
          if (!alvo) return false;
          await tdb
            .update(maquinas)
            .set({ arquivada: true, arquivadaEm: new Date(), online: false })
            .where(eq(maquinas.id, id));
          await tdb.insert(logsServicosWindows).values({
            tenantId,
            usuarioId: userId,
            maquinaId: id,
            servicoNome: "MAQUINA",
            acaoExecutada: "ARQUIVAR",
            statusResultado: "OK",
          });
          return true;
        });
        if (!ok) return reply.code(404).send({ erro: "máquina não encontrada" });
        return reply.send({ ok: true });
      } catch (err) {
        app.log.error({ err, tenantId, id }, "Erro ao arquivar máquina");
        return reply.code(500).send({ erro: "erro interno ao remover máquina" });
      }
    },
  );

  /**
   * GET /instalar.ps1
   * Script PowerShell de instalação one-liner do agente Nexus RMM.
   * Uso: iex (iwr 'https://rmm.gmtec.tec.br/instalar.ps1').Content; Instalar-Nexus -Token "TOKEN"
   */
  app.get("/instalar.ps1", async (_req, reply) => {
    // A8: usar config.PUBLIC_URL — nunca confiar em Host/X-Forwarded-Host (host header injection).
    const baseUrl = config.PUBLIC_URL;
    const host    = new URL(config.PUBLIC_URL).host;

    const script = `# Nexus RMM — Instalador Automático de Agente
# Uso: iex (iwr '${baseUrl}/instalar.ps1').Content; Instalar-Nexus -Token "SEU_TOKEN"
# Gerado automaticamente em ${new Date().toISOString()}

function Instalar-Nexus {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]
        [string]$Token,
        [string]$ServerUrl = "${baseUrl}",
        [string]$GatewayUrl = "wss://${host}:8443"
    )

    $ErrorActionPreference = "Stop"
    $destino = "$env:ProgramData\\NexusRMM"
    $svcName  = "NexusRMM"
    $agentJs  = "$destino\\agent.js"
    $nssmExe  = "$destino\\nssm.exe"

    Write-Host "=== Nexus RMM Installer ===" -ForegroundColor Cyan

    # 1. Criar pasta de instalação
    if (!(Test-Path $destino)) {
        New-Item -ItemType Directory -Path $destino -Force | Out-Null
        Write-Host "[1/5] Pasta criada: $destino" -ForegroundColor Green
    } else {
        Write-Host "[1/5] Pasta já existe: $destino" -ForegroundColor Yellow
    }

    # 2. Verificar Node.js
    $nodePath = $null
    try { $nodePath = (Get-Command node -ErrorAction Stop).Source } catch {}
    if (-not $nodePath) {
        Write-Host "[2/5] Node.js não encontrado. Instalando Node.js 20 LTS..." -ForegroundColor Yellow
        $nodeInstaller = "$env:TEMP\\node-v20-x64.msi"
        $ProgressPreference = "SilentlyContinue"
        Invoke-WebRequest "https://nodejs.org/dist/v20.19.0/node-v20.19.0-x64.msi" -OutFile $nodeInstaller
        Start-Process msiexec.exe -ArgumentList "/i \`"$nodeInstaller\`" /quiet /norestart" -Wait
        $env:PATH = "C:\\Program Files\\nodejs;" + $env:PATH
        try { $nodePath = (Get-Command node -ErrorAction Stop).Source } catch { $nodePath = "C:\\Program Files\\nodejs\\node.exe" }
        Write-Host "[2/5] Node.js instalado." -ForegroundColor Green
    } else {
        $nodeVer = & node --version 2>$null
        Write-Host "[2/5] Node.js já instalado: $nodeVer" -ForegroundColor Green
    }

    # 3. Baixar binários do agente
    Write-Host "[3/5] Baixando agente..." -ForegroundColor Cyan
    $ProgressPreference = "SilentlyContinue"
    try { Invoke-WebRequest "$ServerUrl/agente/agent.js" -OutFile $agentJs } catch {
        Write-Host "ERRO ao baixar agent.js: $_" -ForegroundColor Red; return
    }
    try { Invoke-WebRequest "$ServerUrl/agente/nssm.exe" -OutFile $nssmExe } catch {
        Write-Host "ERRO ao baixar nssm.exe: $_" -ForegroundColor Red; return
    }
    Write-Host "[3/5] Binários baixados." -ForegroundColor Green

    # 4. Parar e remover serviço anterior (se existir)
    Write-Host "[4/5] Configurando serviço Windows..." -ForegroundColor Cyan
    $existing = Get-Service -Name $svcName -ErrorAction SilentlyContinue
    if ($existing) {
        & $nssmExe stop $svcName 2>$null | Out-Null
        Start-Sleep -Seconds 2
        & $nssmExe remove $svcName confirm 2>$null | Out-Null
    }

    # 5. Instalar serviço via NSSM
    & $nssmExe install $svcName $nodePath $agentJs | Out-Null
    & $nssmExe set $svcName DisplayName "Nexus RMM Agent" | Out-Null
    & $nssmExe set $svcName Description "Agente de monitoramento remoto Nexus RMM" | Out-Null
    & $nssmExe set $svcName Start SERVICE_AUTO_START | Out-Null
    & $nssmExe set $svcName AppParameters "--token=$Token" | Out-Null
    & $nssmExe set $svcName AppEnvironmentExtra "NEXUS_API_URL=$ServerUrl" "NEXUS_GATEWAY_URL=$GatewayUrl" "NEXUS_ENROLL_TOKEN=$Token" | Out-Null
    & $nssmExe set $svcName AppStdout "$destino\\nexus-agent.log" | Out-Null
    & $nssmExe set $svcName AppStderr "$destino\\nexus-agent-error.log" | Out-Null
    & $nssmExe set $svcName AppRotateFiles 1 | Out-Null
    & $nssmExe set $svcName AppRotateBytes 10485760 | Out-Null  # 10MB
    & $nssmExe start $svcName | Out-Null

    Start-Sleep -Seconds 3
    $status = (Get-Service -Name $svcName -ErrorAction SilentlyContinue)?.Status
    Write-Host "[5/5] Serviço iniciado. Status: $status" -ForegroundColor $(if ($status -eq 'Running') { 'Green' } else { 'Yellow' })
    Write-Host ""
    Write-Host "=== Instalação concluída! ===" -ForegroundColor Cyan
    Write-Host "Servidor : $ServerUrl" -ForegroundColor Gray
    Write-Host "Serviço  : $svcName ($status)" -ForegroundColor Gray
    Write-Host "Logs     : $destino\\nexus-agent.log" -ForegroundColor Gray
    Write-Host ""
    Write-Host "A máquina aparecerá no painel em alguns instantes." -ForegroundColor Green
}

Write-Host "Script Nexus RMM carregado. Execute: Instalar-Nexus -Token 'SEU_TOKEN'" -ForegroundColor Cyan
`;

    reply.header("Content-Type", "text/plain; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    return reply.send(script);
  });
};
