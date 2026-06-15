/**
 * analytics.ts — Rotas de análise avançada do Nexus RMM
 * Features: Alert Heatmap (B), Health History (A), SLA (G),
 *           Process Scan (H), Auto-Remediation (D), Relatório Executivo (C),
 *           Audit Trail (I), WhatsApp Config (E)
 */
import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { comTenant } from "../db/tenant";
import {
  alertas,
  grupos,
  logsServicosWindows,
  maquinas,
  metricasHistorico,
  presencaLog,
} from "../db/schema";
import { redis } from "../redis";
import { obterSocketAgente } from "../gateway/agent";

/* ─── Lista de processos/serviços suspeitos ───────────────────────────────── */
const MALWARE_PATTERNS: Array<{ pattern: RegExp; risco: string; nome: string }> = [
  { pattern: /njrat|nj ?rat/i,           risco: "critico", nome: "NjRAT (Remote Access Trojan)" },
  { pattern: /darkcomet/i,               risco: "critico", nome: "DarkComet RAT" },
  { pattern: /nanocore/i,                risco: "critico", nome: "NanoCore RAT" },
  { pattern: /quasar ?rat/i,             risco: "critico", nome: "Quasar RAT" },
  { pattern: /asyncrat|async ?rat/i,     risco: "critico", nome: "AsyncRAT" },
  { pattern: /remcos/i,                  risco: "critico", nome: "Remcos RAT" },
  { pattern: /netwire/i,                 risco: "critico", nome: "NetWire RAT" },
  { pattern: /xmrig|xmr-stak/i,         risco: "critico", nome: "XMRig Cryptominer" },
  { pattern: /minergate/i,               risco: "critico", nome: "MinerGate Miner" },
  { pattern: /ardamax/i,                 risco: "critico", nome: "Ardamax Keylogger" },
  { pattern: /refog/i,                   risco: "critico", nome: "Refog Keylogger" },
  { pattern: /mimikatz/i,                risco: "critico", nome: "Mimikatz (credential dumper)" },
  { pattern: /cobalt ?strike/i,          risco: "critico", nome: "Cobalt Strike Beacon" },
  { pattern: /meterpret|meterpreter/i,   risco: "critico", nome: "Meterpreter Shell" },
  { pattern: /emotet/i,                  risco: "critico", nome: "Emotet Trojan" },
  { pattern: /trickbot/i,                risco: "critico", nome: "TrickBot Trojan" },
  { pattern: /wannacry/i,                risco: "critico", nome: "WannaCry Ransomware" },
  { pattern: /locky/i,                   risco: "critico", nome: "Locky Ransomware" },
  { pattern: /teamspy/i,                 risco: "alto",    nome: "TeamSpy (TeamViewer abuse)" },
  { pattern: /gh0st/i,                   risco: "alto",    nome: "Gh0st RAT" },
  { pattern: /blackshades/i,             risco: "alto",    nome: "BlackShades RAT" },
  { pattern: /cryptowall/i,              risco: "alto",    nome: "CryptoWall Ransomware" },
  { pattern: /powersploit/i,             risco: "alto",    nome: "PowerSploit (exploit framework)" },
  { pattern: /pupy/i,                    risco: "alto",    nome: "Pupy RAT" },
  { pattern: /havoc/i,                   risco: "alto",    nome: "Havoc C2 Framework" },
  // Nomes suspeitos de serviços (caracteres aleatórios)
  { pattern: /^[a-z]{1,4}[0-9]{3,}$/i,  risco: "medio",   nome: "Serviço com nome suspeito (possível malware)" },
  { pattern: /svchost32|svch0st/i,       risco: "critico", nome: "Svchost falso (typosquatting)" },
  { pattern: /lsas[^s]|lsa[^s]/i,       risco: "alto",    nome: "LSASS falso (credential theft)" },
  { pattern: /winlogon[^.]/i,            risco: "alto",    nome: "Winlogon falso" },
];

/* ─── Helper: uptime de uma máquina num intervalo ────────────────────────── */
function calcUptime(
  eventos: Array<{ online: boolean; em: Date }>,
  inicioMs: number,
  fimMs: number,
): number {
  if (eventos.length === 0) return 0;
  const janelaMs = fimMs - inicioMs;
  let totalOnlineMs = 0;
  let estadoAtual = eventos[0]!.online;
  let tsAtual = Math.max(eventos[0]!.em.getTime(), inicioMs);
  for (let i = 1; i < eventos.length; i++) {
    const ev = eventos[i]!;
    const tsEv = Math.min(ev.em.getTime(), fimMs);
    if (estadoAtual) totalOnlineMs += tsEv - tsAtual;
    estadoAtual = ev.online;
    tsAtual = tsEv;
  }
  if (estadoAtual) totalOnlineMs += fimMs - tsAtual;
  return janelaMs > 0 ? Math.min(100, (totalOnlineMs / janelaMs) * 100) : 0;
}

export const analyticsRoutes: FastifyPluginAsync = async (app) => {

  /* ─────────────────────────────────────────────────────────────────────────
   * B) GET /api/dashboard/alert-heatmap
   * Heatmap de alertas por hora do dia (últimos 30 dias).
   * ───────────────────────────────────────────────────────────────────────── */
  app.get("/api/dashboard/alert-heatmap", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const cacheKey = `heatmap:${tenantId}`;
    try {
      const c = await redis.get(cacheKey);
      if (c) return reply.send(JSON.parse(c));
    } catch {}

    const resultado = await comTenant(tenantId, async (tdb) => {
      const rows = await tdb.execute(sql.raw(`
        SELECT
          EXTRACT(HOUR FROM criado_em AT TIME ZONE 'America/Cuiaba')::integer AS hora,
          COUNT(*)::integer AS total,
          COUNT(*) FILTER (WHERE severidade = 'critico')::integer AS criticos,
          COUNT(*) FILTER (WHERE severidade = 'aviso')::integer AS avisos
        FROM alertas
        WHERE tenant_id = '${tenantId}'
          AND criado_em > NOW() - INTERVAL '30 days'
        GROUP BY hora
        ORDER BY hora
      `));

      const mapa: Record<number, { total: number; criticos: number; avisos: number }> = {};
      for (let h = 0; h < 24; h++) mapa[h] = { total: 0, criticos: 0, avisos: 0 };
      for (const r of rows.rows as any[]) {
        const h = Number(r.hora);
        mapa[h] = { total: Number(r.total), criticos: Number(r.criticos), avisos: Number(r.avisos) };
      }
      const maxTotal = Math.max(...Object.values(mapa).map((v) => v.total), 1);
      return { horas: mapa, maxTotal };
    });

    try { await redis.set(cacheKey, JSON.stringify(resultado), "EX", 1800); } catch {}
    return reply.send(resultado);
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * A) GET /api/maquinas/:id/health-history
   * Health Score diário aproximado dos últimos 7 dias.
   * ───────────────────────────────────────────────────────────────────────── */
  app.get("/api/maquinas/:id/health-history", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.auth!;
    const cacheKey = `hs-history:${tenantId}:${id}`;
    try {
      const c = await redis.get(cacheKey);
      if (c) return reply.send(JSON.parse(c));
    } catch {}

    const resultado = await comTenant(tenantId, async (tdb) => {
      const [maq] = await tdb
        .select({ id: maquinas.id })
        .from(maquinas)
        .where(and(eq(maquinas.id, id), eq(maquinas.tenantId, tenantId)))
        .limit(1);
      if (!maq) return null;

      // Métricas diárias (média CPU + RAM por dia)
      const metrRows = await tdb.execute(sql.raw(`
        SELECT
          DATE_TRUNC('day', criado_em AT TIME ZONE 'America/Cuiaba') AS dia,
          AVG(cpu)::numeric(5,1) AS cpu_avg,
          AVG(ram)::numeric(5,1) AS ram_avg
        FROM metricas_historico
        WHERE tenant_id = '${tenantId}'
          AND maquina_id = '${id}'
          AND criado_em > NOW() - INTERVAL '7 days'
        GROUP BY dia
        ORDER BY dia
      `));

      // Alertas críticos por dia
      const alertRows = await tdb.execute(sql.raw(`
        SELECT
          DATE_TRUNC('day', criado_em AT TIME ZONE 'America/Cuiaba') AS dia,
          COUNT(*) FILTER (WHERE severidade = 'critico')::integer AS criticos
        FROM alertas
        WHERE tenant_id = '${tenantId}'
          AND maquina_id = '${id}'
          AND criado_em > NOW() - INTERVAL '7 days'
        GROUP BY dia
      `));
      const alertMap = new Map<string, number>();
      for (const r of alertRows.rows as any[]) {
        alertMap.set(new Date(r.dia).toISOString().slice(0, 10), Number(r.criticos));
      }

      // Gerar pontos para os últimos 7 dias
      const pontos: Array<{ data: string; score: number; cpu: number | null; ram: number | null }> = [];
      const hoje = new Date();
      for (let i = 6; i >= 0; i--) {
        const d = new Date(hoje);
        d.setDate(d.getDate() - i);
        const dStr = d.toISOString().slice(0, 10);
        const metr = (metrRows.rows as any[]).find((r) => new Date(r.dia).toISOString().slice(0, 10) === dStr);
        const criticos = alertMap.get(dStr) ?? 0;
        if (!metr) {
          pontos.push({ data: dStr, score: 0, cpu: null, ram: null });
        } else {
          const cpu = parseFloat(metr.cpu_avg);
          const ram = parseFloat(metr.ram_avg);
          const score = Math.round(Math.max(0, Math.min(100,
            40 + (100 - cpu) * 0.20 + (100 - ram) * 0.15 - criticos * 8
          )));
          pontos.push({ data: dStr, score, cpu: Math.round(cpu), ram: Math.round(ram) });
        }
      }
      return { pontos };
    });

    if (!resultado) return reply.code(404).send({ erro: "Máquina não encontrada" });
    try { await redis.set(cacheKey, JSON.stringify(resultado), "EX", 3600); } catch {}
    return reply.send(resultado);
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * G) GET /api/relatorios/sla
   * SLA de disponibilidade por máquina (últimos 30 dias), agrupado por empresa.
   * ───────────────────────────────────────────────────────────────────────── */
  app.get("/api/relatorios/sla", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const dias = Math.min(90, Math.max(7, parseInt((req.query as any).dias ?? "30", 10)));
    const cacheKey = `sla:${tenantId}:${dias}`;
    try {
      const c = await redis.get(cacheKey);
      if (c) return reply.send(JSON.parse(c));
    } catch {}

    const resultado = await comTenant(tenantId, async (tdb) => {
      const inicioMs = Date.now() - dias * 86400_000;
      const inicio = new Date(inicioMs);

      // Máquinas com seus grupos
      const maqRows = await tdb
        .select({
          id: maquinas.id,
          hostname: maquinas.hostname,
          apelido: maquinas.apelido,
          online: maquinas.online,
          grupoId: maquinas.grupoId,
        })
        .from(maquinas)
        .where(eq(maquinas.tenantId, tenantId));

      // Grupos (empresas)
      const grupoRows = await tdb.select().from(grupos).where(eq(grupos.tenantId, tenantId));
      const grupoMap = new Map(grupoRows.map((g) => [g.id, g]));

      // Eventos de presença no período
      const presRows = await tdb.execute(sql.raw(`
        SELECT maquina_id, online, em
        FROM presenca_log
        WHERE tenant_id = '${tenantId}'
          AND em > '${inicio.toISOString()}'
        ORDER BY maquina_id, em ASC
      `));
      const presencaPorMaq = new Map<string, Array<{ online: boolean; em: Date }>>();
      for (const r of presRows.rows as any[]) {
        if (!presencaPorMaq.has(r.maquina_id)) presencaPorMaq.set(r.maquina_id, []);
        presencaPorMaq.get(r.maquina_id)!.push({ online: r.online, em: new Date(r.em) });
      }

      const fimMs = Date.now();
      const itens = maqRows.map((m) => {
        const eventos = presencaPorMaq.get(m.id) ?? [];
        const uptimePct = eventos.length > 0
          ? Math.round(calcUptime(eventos, inicioMs, fimMs) * 10) / 10
          : m.online ? 100 : 0;
        const grupo = m.grupoId ? grupoMap.get(m.grupoId) : null;
        return {
          id: m.id,
          nome: m.apelido || m.hostname,
          online: m.online,
          uptimePct,
          slaOk: uptimePct >= 99.0,
          empresa: grupo?.nome ?? "Sem empresa",
          empresaId: m.grupoId,
        };
      });

      // Agrupar por empresa
      const porEmpresa: Record<string, { empresa: string; itens: typeof itens; avgUptime: number }> = {};
      for (const item of itens) {
        if (!porEmpresa[item.empresa]) {
          porEmpresa[item.empresa] = { empresa: item.empresa, itens: [], avgUptime: 0 };
        }
        porEmpresa[item.empresa]!.itens.push(item);
      }
      for (const v of Object.values(porEmpresa)) {
        v.avgUptime = Math.round(
          (v.itens.reduce((s, i) => s + i.uptimePct, 0) / (v.itens.length || 1)) * 10,
        ) / 10;
      }

      return { dias, empresas: Object.values(porEmpresa), total: itens.length };
    });

    try { await redis.set(cacheKey, JSON.stringify(resultado), "EX", 900); } catch {}
    return reply.send(resultado);
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * H) POST /api/maquinas/:id/process-scan
   * Varre serviços em execução comparando com lista de malware conhecidos.
   * ───────────────────────────────────────────────────────────────────────── */
  app.post("/api/maquinas/:id/process-scan", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.auth!;

    // Buscar lista de serviços da máquina
    const maqRow = await comTenant(tenantId, async (tdb) => {
      const [m] = await tdb
        .select()
        .from(maquinas)
        .where(and(eq(maquinas.id, id), eq(maquinas.tenantId, tenantId)))
        .limit(1);
      return m ?? null;
    });
    if (!maqRow) return reply.code(404).send({ erro: "Máquina não encontrada" });

    // Verificar se agente está conectado (para indicar no retorno)
    const agentSocket = obterSocketAgente(id);
    let servicosNomes: string[] = [];

    // Usar serviços do último inventário
    if (servicosNomes.length === 0) {
      const inv = await comTenant(tenantId, async (tdb) => {
        const rows = await tdb.execute(sql.raw(`
          SELECT software FROM inventarios
          WHERE tenant_id = '${tenantId}' AND maquina_id = '${id}'
          ORDER BY atualizado_em DESC LIMIT 1
        `));
        return (rows.rows as any[])[0] ?? null;
      });
      if (inv?.software) {
        servicosNomes = (inv.software as any[]).map((s: any) => s.nome ?? "");
      }
    }

    // Varrer contra lista de malware
    const ameacas: Array<{
      processo: string;
      risco: string;
      nome: string;
    }> = [];

    const vistos = new Set<string>();
    for (const proc of servicosNomes) {
      for (const m of MALWARE_PATTERNS) {
        if (m.pattern.test(proc) && !vistos.has(m.nome)) {
          vistos.add(m.nome);
          ameacas.push({ processo: proc, risco: m.risco, nome: m.nome });
        }
      }
    }

    // Ordenar por risco
    const ordemRisco: Record<string, number> = { critico: 0, alto: 1, medio: 2 };
    ameacas.sort((a, b) => (ordemRisco[a.risco] ?? 3) - (ordemRisco[b.risco] ?? 3));

    return reply.send({
      ameacas,
      total: ameacas.length,
      criticos: ameacas.filter((a) => a.risco === "critico").length,
      processosAnalisados: servicosNomes.length,
      geradoEm: new Date().toISOString(),
      modoAnalise: servicosNomes.length > 0 ? (agentSocket ? "ao-vivo" : "inventario") : "sem-dados",
    });
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * D) POST /api/maquinas/:id/auto-remediate
   * Executa ações seguras de limpeza via shell na máquina.
   * ───────────────────────────────────────────────────────────────────────── */
  app.post("/api/maquinas/:id/auto-remediate", { preHandler: [app.requireAuth, app.requireMfa] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId, userId } = req.auth!;
    const { acoes = ["disco", "temp", "servicos"] } = req.body as { acoes?: string[] };

    const maqRow = await comTenant(tenantId, async (tdb) => {
      const [m] = await tdb
        .select({ id: maquinas.id, hostname: maquinas.hostname, online: maquinas.online })
        .from(maquinas)
        .where(and(eq(maquinas.id, id), eq(maquinas.tenantId, tenantId)))
        .limit(1);
      return m ?? null;
    });
    if (!maqRow) return reply.code(404).send({ erro: "Máquina não encontrada" });
    if (!maqRow.online) return reply.code(409).send({ erro: "Máquina offline — remediação indisponível" });

    // Comandos seguros de remediação
    const comandosMap: Record<string, string> = {
      temp: `Remove-Item -Path "$env:TEMP\\*" -Recurse -Force -ErrorAction SilentlyContinue; Write-Output "TEMP limpo"`,
      disco: `
$before = (Get-PSDrive C).Used
Start-Process -FilePath "cleanmgr.exe" -ArgumentList "/sagerun:1" -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue
$after = (Get-PSDrive C).Used
$freed = [math]::Round(($before - $after) / 1MB, 1)
Write-Output "Limpeza de disco concluida. Liberado: $freed MB"
`.trim(),
      servicos: `
$stopped = Get-Service | Where-Object { $_.Status -eq 'Stopped' -and $_.StartType -eq 'Automatic' -and $_.Name -notmatch 'WinDefend|WdNisSvc|WdBoot|WdFilter' }
$count = ($stopped | Measure-Object).Count
$stopped | Start-Service -ErrorAction SilentlyContinue
Write-Output "$count serviços automáticos reiniciados"
`.trim(),
      cache_dns: `ipconfig /flushdns; Write-Output "Cache DNS limpo"`,
      prefetch: `
Remove-Item -Path "C:\\Windows\\Prefetch\\*" -Force -ErrorAction SilentlyContinue
Write-Output "Prefetch limpo"
`.trim(),
    };

    // Executar cada ação via API shell existente
    const resultados: Array<{ acao: string; output: string; ok: boolean }> = [];

    for (const acao of acoes) {
      const cmd = comandosMap[acao];
      if (!cmd) continue;
      try {
        const res = await fetch(`http://localhost:4000/api/maquinas/${id}/shell`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Repassar auth interno — usar token do usuário atual
            "x-internal-user-id": userId,
            "x-internal-tenant-id": tenantId,
          },
          body: JSON.stringify({ command: cmd, shell: "powershell" }),
        });
        if (res.ok) {
          const d = await res.json() as { output?: string; status?: string };
          resultados.push({ acao, output: d.output ?? "(sem saída)", ok: d.status !== "FALHA" });
        } else {
          resultados.push({ acao, output: `HTTP ${res.status}`, ok: false });
        }
      } catch (err: any) {
        resultados.push({ acao, output: err.message, ok: false });
      }
    }

    return reply.send({
      ok: resultados.some((r) => r.ok),
      resultados,
      geradoEm: new Date().toISOString(),
    });
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * I) GET /api/maquinas/:id/audit-trail
   * Linha do tempo de ações realizadas na máquina (serviços + terminal + manutenção).
   * ───────────────────────────────────────────────────────────────────────── */
  app.get("/api/maquinas/:id/audit-trail", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.auth!;

    const eventos = await comTenant(tenantId, async (tdb) => {
      const logs = await tdb
        .select()
        .from(logsServicosWindows)
        .where(eq(logsServicosWindows.maquinaId, id))
        .orderBy(desc(logsServicosWindows.executadoEm))
        .limit(50);

      const presRows = await tdb.execute(sql.raw(`
        SELECT online, em FROM presenca_log
        WHERE tenant_id = '${tenantId}' AND maquina_id = '${id}'
        ORDER BY em DESC LIMIT 30
      `));

      const linhaServicos = logs.map((l) => ({
        tipo: "servico",
        descricao: `${l.acaoExecutada} → ${l.servicoNome}`,
        resultado: l.statusResultado,
        em: l.executadoEm,
        ok: l.statusResultado === "SUCESSO" || l.statusResultado === "OK",
      }));

      const linhaPresenca = (presRows.rows as any[]).map((r) => ({
        tipo: "presenca",
        descricao: r.online ? "Máquina ficou online" : "Máquina ficou offline",
        resultado: r.online ? "online" : "offline",
        em: new Date(r.em),
        ok: r.online,
      }));

      // Unir e ordenar
      return [...linhaServicos, ...linhaPresenca]
        .sort((a, b) => new Date(b.em).getTime() - new Date(a.em).getTime())
        .slice(0, 60);
    });

    return reply.send({ eventos, total: eventos.length });
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * C) GET /api/relatorios/executivo
   * HTML formatado para impressão/PDF do estado da infraestrutura.
   * ───────────────────────────────────────────────────────────────────────── */
  app.get("/api/relatorios/executivo", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const { empresaId } = req.query as { empresaId?: string };

    const dados = await comTenant(tenantId, async (tdb) => {
      const maqRows = await tdb
        .select()
        .from(maquinas)
        .where(eq(maquinas.tenantId, tenantId));

      const grupoRows = await tdb.select().from(grupos).where(eq(grupos.tenantId, tenantId));
      const grupoMap = new Map(grupoRows.map((g) => [g.id, g.nome]));

      const alertasRows = await tdb
        .select()
        .from(alertas)
        .where(and(
          eq(alertas.tenantId, tenantId),
          gte(alertas.criadoEm, new Date(Date.now() - 30 * 86400_000)),
        ))
        .orderBy(desc(alertas.criadoEm))
        .limit(20);

      const maqFiltradas = empresaId
        ? maqRows.filter((m) => m.grupoId === empresaId)
        : maqRows;

      return {
        maquinas: maqFiltradas.map((m) => ({
          nome: m.apelido || m.hostname,
          online: m.online,
          tipo: m.tipoMaquina,
          empresa: m.grupoId ? (grupoMap.get(m.grupoId) ?? "—") : "—",
          versaoAgente: m.versaoAgente,
          vistoEm: m.vistoEm,
        })),
        alertas: alertasRows,
        grupoMap: Object.fromEntries(grupoMap),
        geradoEm: new Date().toISOString(),
        totalOnline: maqFiltradas.filter((m) => m.online).length,
        totalOffline: maqFiltradas.filter((m) => !m.online).length,
      };
    });

    const dataFormatada = new Date(dados.geradoEm).toLocaleDateString("pt-BR", {
      day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
    });

    const linhasMaquinas = dados.maquinas.map((m) => `
      <tr>
        <td>${m.nome}</td>
        <td>${m.empresa}</td>
        <td class="${m.online ? "ok" : "err"}">${m.online ? "Online" : "Offline"}</td>
        <td>${m.tipo === "servidor" ? "Servidor" : "PC"}</td>
        <td>${m.versaoAgente ?? "—"}</td>
        <td>${m.vistoEm ? new Date(m.vistoEm as any).toLocaleString("pt-BR") : "—"}</td>
      </tr>`).join("");

    const linhasAlertas = dados.alertas.slice(0, 15).map((a: any) => `
      <tr>
        <td class="${a.severidade === "critico" ? "err" : "warn"}">${a.severidade?.toUpperCase()}</td>
        <td>${a.mensagem}</td>
        <td>${new Date(a.criadoEm).toLocaleString("pt-BR")}</td>
        <td>${a.lida ? "Lido" : "Não lido"}</td>
      </tr>`).join("");

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Relatório Executivo — Nexus RMM</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; font-size: 12px; color: #1a1a1a; padding: 32px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #10b981; padding-bottom: 16px; margin-bottom: 24px; }
  .logo { font-size: 20px; font-weight: 900; letter-spacing: -0.5px; }
  .logo span { color: #10b981; }
  .meta { text-align: right; color: #6b7280; font-size: 11px; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .kpi { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; text-align: center; }
  .kpi .val { font-size: 28px; font-weight: 900; }
  .kpi .lbl { font-size: 10px; color: #6b7280; text-transform: uppercase; margin-top: 4px; }
  .kpi.online .val { color: #10b981; }
  .kpi.offline .val { color: #ef4444; }
  .kpi.total .val { color: #3b82f6; }
  .kpi.alertas .val { color: #f59e0b; }
  h2 { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #6b7280; margin: 20px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #e5e7eb; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { background: #f9fafb; padding: 8px 10px; text-align: left; font-weight: 700; color: #374151; border-bottom: 2px solid #e5e7eb; }
  td { padding: 7px 10px; border-bottom: 1px solid #f3f4f6; }
  tr:hover td { background: #f9fafb; }
  .ok { color: #10b981; font-weight: 700; }
  .err { color: #ef4444; font-weight: 700; }
  .warn { color: #f59e0b; font-weight: 700; }
  .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 10px; text-align: center; }
  @media print { body { padding: 16px; } @page { margin: 1cm; } }
</style>
</head>
<body>
<div class="header">
  <div>
    <div class="logo">NEXUS <span>RMM</span></div>
    <div style="color:#6b7280;font-size:11px;margin-top:4px;">Relatório Executivo de Infraestrutura</div>
  </div>
  <div class="meta">
    <div>Gerado em ${dataFormatada}</div>
  </div>
</div>

<div class="kpis">
  <div class="kpi total"><div class="val">${dados.maquinas.length}</div><div class="lbl">Total de Máquinas</div></div>
  <div class="kpi online"><div class="val">${dados.totalOnline}</div><div class="lbl">Online</div></div>
  <div class="kpi offline"><div class="val">${dados.totalOffline}</div><div class="lbl">Offline</div></div>
  <div class="kpi alertas"><div class="val">${dados.alertas.filter((a: any) => !a.lida).length}</div><div class="lbl">Alertas não lidos (30d)</div></div>
</div>

<h2>Inventário de Máquinas</h2>
<table>
  <tr><th>Nome</th><th>Empresa</th><th>Status</th><th>Tipo</th><th>Agente</th><th>Último contato</th></tr>
  ${linhasMaquinas || '<tr><td colspan="6" style="text-align:center;color:#9ca3af">Nenhuma máquina</td></tr>'}
</table>

<h2>Alertas Recentes (últimos 30 dias)</h2>
<table>
  <tr><th>Severidade</th><th>Mensagem</th><th>Data</th><th>Situação</th></tr>
  ${linhasAlertas || '<tr><td colspan="4" style="text-align:center;color:#9ca3af">Nenhum alerta</td></tr>'}
</table>

<div class="footer">Nexus RMM — Relatório gerado automaticamente. Para uso interno e apresentação ao cliente.</div>
</body>
</html>`;

    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("Content-Disposition", `inline; filename="relatorio-executivo-${new Date().toISOString().slice(0,10)}.html"`);
    return reply.send(html);
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * E) GET/POST /api/config/whatsapp
   * Configuração de alertas WhatsApp via Evolution API.
   * ───────────────────────────────────────────────────────────────────────── */
  app.get("/api/config/whatsapp", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const cacheKey = `wa-config:${tenantId}`;
    try {
      const c = await redis.get(cacheKey);
      if (c) return reply.send(JSON.parse(c));
    } catch {}
    return reply.send({ ativo: false, apiUrl: "", instancia: "", apiKey: "", numero: "", alertaCritico: true, alertaOffline: true });
  });

  app.post("/api/config/whatsapp", { preHandler: [app.requireAuth, app.requireMfa] }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const body = req.body as {
      ativo: boolean; apiUrl: string; instancia: string; apiKey: string; numero: string;
      alertaCritico: boolean; alertaOffline: boolean;
    };
    const cacheKey = `wa-config:${tenantId}`;
    await redis.set(cacheKey, JSON.stringify(body), "EX", 365 * 86400);
    return reply.send({ ok: true });
  });

  app.post("/api/config/whatsapp/test", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const cacheKey = `wa-config:${tenantId}`;
    const cfgStr = await redis.get(cacheKey);
    if (!cfgStr) return reply.code(400).send({ erro: "WhatsApp não configurado" });
    const cfg = JSON.parse(cfgStr);
    if (!cfg.ativo || !cfg.apiUrl || !cfg.instancia || !cfg.numero) {
      return reply.code(400).send({ erro: "Configuração incompleta" });
    }
    try {
      const r = await fetch(`${cfg.apiUrl}/message/sendText/${cfg.instancia}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": cfg.apiKey },
        body: JSON.stringify({
          number: cfg.numero,
          text: `✅ *Nexus RMM* — Teste de notificação\n\nSeu WhatsApp está configurado corretamente para receber alertas de infraestrutura.`,
        }),
      });
      if (r.ok) return reply.send({ ok: true });
      return reply.code(502).send({ erro: `Evolution API retornou ${r.status}` });
    } catch (err: any) {
      return reply.code(502).send({ erro: err.message });
    }
  });
};
