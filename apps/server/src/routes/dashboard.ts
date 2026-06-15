import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, gt, isNotNull, sql } from "drizzle-orm";
import os from "os";
import { execSync } from "child_process";
import { comTenant } from "../db/tenant";
import { alertas, maquinas, manutencoes, metricasHistorico } from "../db/schema";
import { redis } from "../redis";
import { gerarBriefing } from "../lib/briefing";
import { diagnosticarMaquina } from "../lib/diagnostico";
import { calcularHealthScores } from "../lib/health-score";
import { config } from "../config";

// Mede CPU% real num intervalo de 100ms (comparação de idle antes/depois)
async function medirCpuPct(): Promise<number> {
  const amostra = () => {
    const cpus = os.cpus();
    let idle = 0, total = 0;
    for (const cpu of cpus) {
      for (const t of Object.values(cpu.times)) { total += t; }
      idle += cpu.times.idle;
    }
    return { idle, total };
  };
  const a1 = amostra();
  await new Promise((r) => setTimeout(r, 100));
  const a2 = amostra();
  const idleDiff = a2.idle - a1.idle;
  const totalDiff = a2.total - a1.total;
  return totalDiff > 0 ? Math.round((1 - idleDiff / totalDiff) * 100) : 0;
}

// Disco da raiz via df (Linux/Docker)
function lerDisco(): { totalGB: number; usadoGB: number; livreGB: number; usoPct: number } {
  try {
    const out = execSync("df -BGB / --output=size,used,avail 2>/dev/null | tail -1", { timeout: 2000 }).toString().trim();
    const [tot, used, avail] = out.split(/\s+/).map((v) => parseInt(v.replace("G", ""), 10));
    const totalGB = tot ?? 0;
    const usadoGB = used ?? 0;
    const livreGB = avail ?? 0;
    const usoPct = totalGB > 0 ? Math.round((usadoGB / totalGB) * 100) : 0;
    return { totalGB, usadoGB, livreGB, usoPct };
  } catch {
    return { totalGB: 0, usadoGB: 0, livreGB: 0, usoPct: 0 };
  }
}

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/admin/server-health
   * Métricas em tempo real do servidor RMM (host Docker).
   * Restrito a owner e superAdmin.
   */
  app.get("/api/admin/server-health", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { papel, superAdmin } = req.auth! as any;
    if (papel !== "owner" && !superAdmin) {
      return reply.code(403).send({ erro: "Restrito ao proprietário da conta." });
    }

    const [cpuPct, disco] = await Promise.all([medirCpuPct(), Promise.resolve(lerDisco())]);

    const totalMem = os.totalmem();
    const livreMem = os.freemem();
    const usadoMem = totalMem - livreMem;
    const ramPct = Math.round((usadoMem / totalMem) * 100);

    const uptimeS = Math.floor(os.uptime());
    const d = Math.floor(uptimeS / 86400);
    const h = Math.floor((uptimeS % 86400) / 3600);
    const m = Math.floor((uptimeS % 3600) / 60);
    const uptimeTexto = d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;

    const cpus = os.cpus();
    const loadAvgArr = os.loadavg();
    const load1 = loadAvgArr[0] ?? 0;
    const load5 = loadAvgArr[1] ?? 0;
    const load15 = loadAvgArr[2] ?? 0;
    const proc = process.memoryUsage();

    // Redis info
    let redisMem = "";
    let redisConexoes = 0;
    try {
      const info = await redis.info("memory");
      const match = info.match(/used_memory_human:([^\r\n]+)/);
      redisMem = match?.[1]?.trim() ?? "";
      const clients = await redis.info("clients");
      const cm = clients.match(/connected_clients:(\d+)/);
      redisConexoes = cm ? parseInt(cm[1]!) : 0;
    } catch {}

    return reply.send({
      timestamp: new Date().toISOString(),
      cpu: {
        modelo: cpus[0]?.model?.trim() ?? "desconhecido",
        nucleos: cpus.length,
        usoPct: cpuPct,
        loadAvg: { m1: Math.round(load1 * 100) / 100, m5: Math.round(load5 * 100) / 100, m15: Math.round(load15 * 100) / 100 },
      },
      ram: {
        totalGB: Math.round((totalMem / 1e9) * 10) / 10,
        usadoGB: Math.round((usadoMem / 1e9) * 10) / 10,
        livreGB: Math.round((livreMem / 1e9) * 10) / 10,
        usoPct: ramPct,
      },
      disco,
      uptime: { segundos: uptimeS, texto: uptimeTexto },
      processo: {
        heapUsadoMB: Math.round(proc.heapUsed / 1e6),
        heapTotalMB: Math.round(proc.heapTotal / 1e6),
        rssMB: Math.round(proc.rss / 1e6),
        uptimeS: Math.floor(process.uptime()),
      },
      redis: { memHuman: redisMem, conexoes: redisConexoes },
    });
  });

  /**
   * GET /api/dashboard/briefing
   * Gera (ou retorna do cache) um parágrafo em linguagem natural sobre o estado da infra.
   * Cache Redis: 15 minutos por tenant.
   */
  app.get("/api/dashboard/briefing", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { tenantId } = req.auth!;

    // Cache Redis — 15 min
    const cacheKey = `briefing:${tenantId}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return reply.send({ briefing: cached, cached: true });
    } catch {
      // Redis indisponível: segue sem cache
    }

    try {
      const resultado = await comTenant(tenantId, async (tdb) => {
        const [maquinaRows, alertaRows] = await Promise.all([
          tdb
            .select({
              id: maquinas.id,
              apelido: maquinas.apelido,
              hostname: maquinas.hostname,
              online: maquinas.online,
              vistoEm: maquinas.vistoEm,
            })
            .from(maquinas),

          tdb
            .select({
              severidade: alertas.severidade,
              lida: alertas.lida,
            })
            .from(alertas)
            .where(gt(alertas.criadoEm, new Date(Date.now() - 24 * 3600_000))),
        ]);

        const agora = Date.now();
        const offlineMaquinas = maquinaRows
          .filter((m) => !m.online)
          .map((m) => {
            const diffMs = m.vistoEm ? agora - new Date(m.vistoEm).getTime() : 0;
            const diffH = Math.round(diffMs / 3600_000);
            return {
              nome: m.apelido || m.hostname,
              offlineHa: diffH > 0 ? `${diffH}h` : "pouco tempo",
            };
          });

        const alertasCriticos = alertaRows.filter((a) => a.severidade === "critico" && !a.lida).length;
        const alertasNaoLidos = alertaRows.filter((a) => !a.lida).length;

        // Discos em risco: última amostra de cada máquina online
        const discosEmRisco: Array<{
          maquina: string;
          disco: string;
          pct: number;
          diasRestantes: number | null;
        }> = [];

        const maquinasOnline = maquinaRows.filter((m) => m.online);
        for (const maq of maquinasOnline) {
          if (discosEmRisco.length >= 3) break;

          const ultimaAmostra = await tdb
            .select({ disco: metricasHistorico.disco })
            .from(metricasHistorico)
            .where(
              and(
                eq(metricasHistorico.tenantId, tenantId),
                eq(metricasHistorico.maquinaId, maq.id),
                isNotNull(metricasHistorico.disco),
              ),
            )
            .orderBy(desc(metricasHistorico.criadoEm))
            .limit(1);

          const discos =
            (ultimaAmostra[0]?.disco as Array<{ caminho: string; usoPct: number }>) ?? [];
          for (const d of discos) {
            if (d.usoPct >= 75) {
              discosEmRisco.push({
                maquina: maq.apelido || maq.hostname,
                disco: d.caminho,
                pct: d.usoPct,
                diasRestantes: null,
              });
            }
          }
        }

        const onlineCount = maquinaRows.filter((m) => m.online).length;

        return {
          totalMaquinas: maquinaRows.length,
          online: onlineCount,
          offline: maquinaRows.length - onlineCount,
          maquinasOffline: offlineMaquinas,
          alertasCriticos,
          alertasNaoLidos,
          discosEmRisco,
          healthScoreMedia: null,
          hora: new Date().getHours(),
        };
      });

      const briefing = await gerarBriefing(resultado);

      try {
        await redis.set(cacheKey, briefing, "EX", 900); // 15 min
      } catch {
        // Redis indisponível: retorna sem cachear
      }

      return reply.send({ briefing, cached: false });
    } catch (err) {
      app.log.error({ err, tenantId }, "Erro ao gerar briefing do dashboard");
      return reply.code(500).send({ erro: "erro ao gerar briefing" });
    }
  });

  /**
   * POST /api/copilot/translate
   * Traduz uma instrução em português para um comando PowerShell via IA.
   */
  app.post("/api/copilot/translate", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { descricao, shell = "powershell", soVersao = "Windows" } = req.body as {
      descricao: string;
      shell?: string;
      soVersao?: string;
    };

    if (!descricao?.trim()) {
      return reply.code(400).send({ erro: "Descrição obrigatória" });
    }

    if (!config.ANTHROPIC_API_KEY) {
      return reply.send({
        comando: "",
        explicacao: "Configure ANTHROPIC_API_KEY para usar o Copilot com IA.",
        semIA: true,
      });
    }

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

    const prompt = `Você é um especialista em PowerShell e administração Windows.
Traduza a instrução abaixo para um comando PowerShell de uma única linha.

Instrução: "${descricao}"
Sistema: ${soVersao}
Shell: ${shell}

Responda APENAS com JSON no formato:
{"comando": "o-comando-aqui", "explicacao": "uma linha explicando o que faz"}

Regras OBRIGATÓRIAS:
- Comando deve ser executável diretamente no PowerShell
- Uma única linha SOMENTE — use ponto-e-vírgula (;) para encadear se necessário, mas nunca quebras de linha
- Se a instrução for ambígua, escolha a interpretação mais segura
- NÃO inclua comandos destrutivos sem confirmação explícita (rm, format, delete) — adicione -WhatIf nesses casos
- Use APENAS caracteres ASCII no campo "comando" — sem acentos, sem caracteres especiais
- Prefira comandos nativos e simples: rundll32, Start-Process, Get-Process, etc.
- NUNCA use Add-Type para funções Win32 que possuem alternativa nativa (ex: para LockWorkStation use "rundll32.exe user32.dll,LockWorkStation")
- Se Add-Type for absolutamente necessário, suprima o output com: $null = Add-Type ...
- Suprima output desnecessário com | Out-Null quando o resultado não é importante ao usuario
- A explicacao pode ser em português, mas o campo "comando" deve ser 100% ASCII`;

    try {
      const message = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      });

      const text = (message.content[0] as { text: string }).text;

      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("no json");
      const parsed = JSON.parse(match[0]);
      return reply.send({ comando: parsed.comando, explicacao: parsed.explicacao });
    } catch {
      return reply.send({ comando: "", explicacao: "Erro ao processar a resposta da IA." });
    }
  });

  /**
   * POST /api/maquinas/:id/diagnostico
   * Diagnóstico automático IA quando máquina está crítica.
   * Cache Redis: 5 minutos. Use ?forcar=true para invalidar.
   */
  app.post("/api/maquinas/:id/diagnostico", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.auth!;
    const forcar = (req.query as any).forcar === "true";

    const cacheKey = `diagnostico:${tenantId}:${id}`;

    // Verificar cache (exceto se forcar=true)
    if (!forcar) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) return reply.send({ ...JSON.parse(cached), cached: true });
      } catch {
        // Redis indisponível, segue
      }
    }

    try {
      const resultado = await comTenant(tenantId, async (tdb) => {
        // 1. Verificar que a máquina pertence ao tenant
        const [maq] = await tdb
          .select()
          .from(maquinas)
          .where(and(eq(maquinas.id, id), eq(maquinas.tenantId, tenantId)))
          .limit(1);

        if (!maq) return null;

        // 2. Calcular health score + componentes
        const scores = await calcularHealthScores(tdb, tenantId, [{ id: maq.id, online: maq.online }]);
        const hs = scores.get(maq.id);

        // 3. Alertas ativos (últimas 24h, top 5 mais recentes)
        const alertasRows = await tdb
          .select({
            tipo: alertas.tipo,
            severidade: alertas.severidade,
            mensagem: alertas.mensagem,
            criadoEm: alertas.criadoEm,
          })
          .from(alertas)
          .where(
            and(
              eq(alertas.tenantId, tenantId),
              eq(alertas.maquinaId, id),
              gt(alertas.criadoEm, new Date(Date.now() - 24 * 3600_000)),
            ),
          )
          .orderBy(desc(alertas.criadoEm))
          .limit(5);

        // 4. CPU/RAM pico na última 1h
        const picos = await tdb.execute(sql.raw(`
          SELECT
            MAX(cpu)::integer AS cpu_pico,
            MAX(ram)::integer AS ram_pico
          FROM metricas_historico
          WHERE tenant_id = '${tenantId}'
            AND maquina_id = '${id}'
            AND criado_em > NOW() - INTERVAL '1 hour'
        `));
        const picoRow = (picos.rows as any[])[0] ?? {};

        return {
          maq,
          hs,
          alertasRows,
          cpuPico: picoRow.cpu_pico != null ? Number(picoRow.cpu_pico) : null,
          ramPico: picoRow.ram_pico != null ? Number(picoRow.ram_pico) : null,
        };
      });

      if (!resultado) {
        return reply.code(404).send({ erro: "Máquina não encontrada" });
      }

      const { maq, hs, alertasRows, cpuPico, ramPico } = resultado;

      const diagnostico = await diagnosticarMaquina({
        maquina: {
          hostname: maq.hostname,
          apelido: maq.apelido,
          online: maq.online,
          soVersao: maq.soVersao,
          vistoEm: maq.vistoEm,
          tipoMaquina: maq.tipoMaquina,
        },
        healthScore: hs?.score ?? null,
        componentes: hs?.componentes ?? {
          cpuMedia: null,
          ramMedia: null,
          discoUsoPct: null,
          uptimePct: 0,
          alertasCriticos: 0,
          alertasAvisos: 0,
        },
        alertasRecentes: alertasRows.map((a) => ({
          tipo: a.tipo,
          severidade: a.severidade,
          mensagem: a.mensagem,
          criadoEm: a.criadoEm instanceof Date ? a.criadoEm : new Date(a.criadoEm as string),
        })),
        cpuPico,
        ramPico,
      });

      // Cache Redis 5 minutos
      try {
        await redis.set(cacheKey, JSON.stringify(diagnostico), "EX", 300);
      } catch {
        // Redis indisponível
      }

      return reply.send({ ...diagnostico, cached: false });
    } catch (err) {
      app.log.error({ err, tenantId, maquinaId: id }, "Erro ao gerar diagnóstico");
      return reply.code(500).send({ erro: "Erro ao gerar diagnóstico" });
    }
  });

  /**
   * POST /api/terminal/resumo
   * Gera resumo IA de uma sessão de terminal e salva como manutenção.
   * Chamado automaticamente pelo frontend ao encerrar sessão.
   */
  app.post("/api/terminal/resumo", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { tenantId, userId } = req.auth!;
    const body = req.body as {
      maquinaId: string;
      comandos: string[];
      duracaoSegundos: number;
      shell: string;
    };

    if (!body.maquinaId || !Array.isArray(body.comandos) || body.comandos.length === 0) {
      return reply.code(400).send({ erro: "maquinaId e comandos são obrigatórios" });
    }

    // Filtra comandos em branco e limita a 50
    const comandos = body.comandos
      .map((c) => c.trim())
      .filter((c) => c.length > 0)
      .slice(0, 50);

    if (comandos.length === 0) {
      return reply.code(400).send({ erro: "nenhum comando útil encontrado" });
    }

    const shell = body.shell || "powershell";
    const duracaoMin = Math.round((body.duracaoSegundos || 0) / 60);

    // Verificar que máquina pertence ao tenant
    const maqRow = await comTenant(tenantId, async (tdb) => {
      const [m] = await tdb
        .select({ id: maquinas.id, hostname: maquinas.hostname, apelido: maquinas.apelido })
        .from(maquinas)
        .where(and(eq(maquinas.id, body.maquinaId), eq(maquinas.tenantId, tenantId)))
        .limit(1);
      return m ?? null;
    });

    if (!maqRow) {
      return reply.code(404).send({ erro: "Máquina não encontrada" });
    }

    const nomeMaquina = maqRow.apelido || maqRow.hostname;

    // Gerar resumo
    let resumo = "";
    let categoria: "manutencao" | "diagnostico" | "configuracao" | "investigacao" | "rotina" = "rotina";
    let semIA = false;

    if (config.ANTHROPIC_API_KEY) {
      try {
        const Anthropic = (await import("@anthropic-ai/sdk")).default;
        const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

        const prompt = `Você é um técnico de TI que precisa registrar no histórico uma sessão de terminal.

Máquina: ${nomeMaquina}
Shell: ${shell.toUpperCase()}
Duração: ~${duracaoMin} minuto${duracaoMin !== 1 ? "s" : ""}
Comandos executados (${comandos.length}):
${comandos.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Analise os comandos e responda APENAS com JSON:
{
  "resumo": "Parágrafo de 2-3 frases descrevendo o que foi feito na sessão, em português",
  "categoria": "manutencao" | "diagnostico" | "configuracao" | "investigacao" | "rotina"
}

Escolha a categoria mais adequada:
- "manutencao": limpeza, desinstalação, reparo
- "diagnostico": verificação de logs, análise de problemas
- "configuracao": alterações de config, instalação, setup
- "investigacao": verificação de processos, serviços, recursos
- "rotina": comandos gerais, verificações rápidas`;

        const message = await client.messages.create({
          model: "claude-haiku-4-5",
          max_tokens: 300,
          messages: [{ role: "user", content: prompt }],
        });

        const text = (message.content[0] as { text: string }).text;
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          resumo = parsed.resumo || "";
          const cats = ["manutencao", "diagnostico", "configuracao", "investigacao", "rotina"] as const;
          if (cats.includes(parsed.categoria)) categoria = parsed.categoria;
        }
      } catch {
        semIA = true;
      }
    } else {
      semIA = true;
    }

    // Fallback determinístico
    if (!resumo || semIA) {
      semIA = true;
      // Detectar categoria pelos comandos
      const cmdsJoin = comandos.join(" ").toLowerCase();
      if (/get-eventlog|eventvwr|wevtutil|get-winevent/.test(cmdsJoin)) categoria = "diagnostico";
      else if (/install|setup|new-item|reg add|set-|enable-|disable-/.test(cmdsJoin)) categoria = "configuracao";
      else if (/get-process|tasklist|netstat|ipconfig|ping|test-connection/.test(cmdsJoin)) categoria = "investigacao";
      else if (/remove-|uninstall|clean|del |rmdir/.test(cmdsJoin)) categoria = "manutencao";

      const primeiroCmd = comandos[0];
      const ultimoCmd = comandos[comandos.length - 1];
      resumo = `Sessão de terminal ${shell.toUpperCase()} na máquina ${nomeMaquina} com duração de ~${duracaoMin} minuto${duracaoMin !== 1 ? "s" : ""}. `
        + `${comandos.length} comando${comandos.length !== 1 ? "s" : ""} executado${comandos.length !== 1 ? "s" : ""}, iniciando com "${primeiroCmd}"${comandos.length > 1 ? ` e encerrando com "${ultimoCmd}"` : ""}. `
        + `Sessão encerrada normalmente.`;
    }

    // Mapear categoria → tipo de manutenção
    const tipoMap: Record<string, "corretiva" | "preventiva" | "melhoria" | "instalacao"> = {
      manutencao: "corretiva",
      diagnostico: "corretiva",
      configuracao: "melhoria",
      investigacao: "corretiva",
      rotina: "preventiva",
    };
    const tipo = tipoMap[categoria] ?? "corretiva";

    // Montar descrição completa para o registro
    const descricao = `[Sessão Terminal — Resumo IA]\n\n${resumo}\n\n---\nShell: ${shell.toUpperCase()} | Duração: ~${duracaoMin} min | Comandos: ${comandos.length}\n\nComandos executados:\n${comandos.map((c, i) => `${i + 1}. ${c}`).join("\n")}`;

    // Salvar no histórico de manutenções
    const manutId = await comTenant(tenantId, async (tdb) => {
      const [novo] = await tdb
        .insert(manutencoes)
        .values({
          tenantId,
          maquinaId: body.maquinaId,
          tipo,
          descricao,
          tecnico: `Sistema (sessão terminal — ${userId})`,
          statusManut: "concluida",
          dataManutencao: new Date(),
        })
        .returning({ id: manutencoes.id });
      return novo?.id ?? null;
    });

    return reply.send({
      ok: true,
      resumo,
      categoria,
      tipo,
      manutencaoId: manutId,
      semIA,
    });
  });

  /**
   * POST /api/maquinas/:id/vulnerabilidades
   * Scanner CVE via IA — analisa softwares instalados e identifica versões vulneráveis.
   * Cache Redis: 6 horas. Use ?forcar=true para invalidar.
   */
  app.post("/api/maquinas/:id/vulnerabilidades", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.auth!;
    const forcar = (req.query as any).forcar === "true";

    const cacheKey = `vulns:${tenantId}:${id}`;

    if (!forcar) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) return reply.send({ ...JSON.parse(cached), cached: true });
      } catch {}
    }

    // Buscar inventário da máquina
    const inventarioRow = await comTenant(tenantId, async (tdb) => {
      const rows = await tdb.execute(sql.raw(`
        SELECT software, hardware, so
        FROM inventarios
        WHERE tenant_id = '${tenantId}'
          AND maquina_id = '${id}'
        ORDER BY atualizado_em DESC
        LIMIT 1
      `));
      return (rows.rows as any[])[0] ?? null;
    });

    if (!inventarioRow) {
      return reply.code(404).send({ erro: "Inventário não encontrado para esta máquina. Aguarde o agente coletar os dados." });
    }

    const software: Array<{ nome: string; versao?: string; fornecedor?: string }> =
      Array.isArray(inventarioRow.software) ? inventarioRow.software : [];
    const soInfo: any = inventarioRow.so ?? {};

    if (software.length === 0) {
      return reply.code(400).send({ erro: "Nenhum software encontrado no inventário." });
    }

    const softwareLista = software.slice(0, 150);
    const soStr = soInfo.nome ? `${soInfo.nome} ${soInfo.versao || ""}`.trim() : "Windows";

    interface Vulnerabilidade {
      software: string;
      versao: string;
      risco: "critico" | "alto" | "medio" | "baixo";
      descricao: string;
      cve: string | null;
      recomendacao: string;
    }

    let vulnerabilidades: Vulnerabilidade[] = [];
    let resumo = "";
    let semIA = false;

    if (config.ANTHROPIC_API_KEY) {
      try {
        const Anthropic = (await import("@anthropic-ai/sdk")).default;
        const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

        const listaTexto = softwareLista
          .map((s) => `- ${s.nome}${s.versao ? ` v${s.versao}` : ""}${s.fornecedor ? ` (${s.fornecedor})` : ""}`)
          .join("\n");

        const prompt = `Você é um especialista em segurança da informação analisando o inventário de uma máquina Windows.

Sistema Operacional: ${soStr}

Softwares instalados (${softwareLista.length}):
${listaTexto}

Analise esta lista e identifique softwares com vulnerabilidades conhecidas, versões desatualizadas críticas, software EOL (end-of-life) ou com CVEs relevantes.

Foque em:
1. Navegadores desatualizados (Chrome, Firefox, Edge, IE)
2. Java/JRE/JDK com vulnerabilidades conhecidas
3. Microsoft Office com patches pendentes
4. Adobe Reader/Flash/Acrobat vulneráveis
5. OpenSSL/OpenSSH desatualizados
6. VPN clients, remote desktop tools com CVEs conhecidos
7. SO: Windows versões EOL ou sem patches críticos
8. Softwares com RCE (Remote Code Execution) conhecidas
9. Softwares de acesso remoto (TeamViewer, AnyDesk versões antigas)
10. Outros softwares críticos com CVEs públicos

Responda APENAS com JSON:
{
  "vulnerabilidades": [
    {
      "software": "nome do software",
      "versao": "versão encontrada ou 'desconhecida'",
      "risco": "critico" | "alto" | "medio" | "baixo",
      "descricao": "descrição clara do risco em português, 1-2 frases",
      "cve": "CVE-XXXX-XXXXX ou null se não tiver CVE específico",
      "recomendacao": "ação específica recomendada em português"
    }
  ],
  "resumo": "Resumo em 1-2 frases do estado de segurança da máquina em português"
}

Regras:
- Inclua APENAS software realmente problemático. Se estiver atualizado e seguro, não liste.
- Máximo 20 itens
- Se nenhum risco for encontrado, retorne vulnerabilidades: [] e resumo positivo
- risco "critico" = RCE conhecida, exploit ativo, EOL crítico
- risco "alto" = CVE sem patch, versão muito desatualizada
- risco "medio" = versão desatualizada sem CVE crítico
- risco "baixo" = monitoramento recomendado`;

        const message = await client.messages.create({
          model: "claude-haiku-4-5",
          max_tokens: 2000,
          messages: [{ role: "user", content: prompt }],
        });

        const text = (message.content[0] as { text: string }).text;
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          vulnerabilidades = Array.isArray(parsed.vulnerabilidades) ? parsed.vulnerabilidades.slice(0, 20) : [];
          resumo = typeof parsed.resumo === "string" ? parsed.resumo : "";
        }
      } catch {
        semIA = true;
      }
    } else {
      semIA = true;
    }

    // Fallback heurístico
    if (semIA || !resumo) {
      semIA = true;
      const heuristicas: Array<{
        pattern: RegExp;
        risco: "critico" | "alto" | "medio" | "baixo";
        descricao: string;
        cve: string | null;
        recomendacao: string;
      }> = [
        { pattern: /internet explorer/i, risco: "critico", descricao: "Internet Explorer está em EOL desde junho de 2022 e não recebe mais patches de segurança.", cve: null, recomendacao: "Remover o Internet Explorer e migrar para Edge ou Chrome." },
        { pattern: /adobe flash/i, risco: "critico", descricao: "Adobe Flash Player está em EOL desde dezembro de 2020 e é um vetor crítico de ataques.", cve: "CVE-2021-21017", recomendacao: "Desinstalar o Adobe Flash Player imediatamente." },
        { pattern: /\bjava\b.*\b(8|7|6)\b|\bjre\b|\bjdk\s*(8|7|6)/i, risco: "alto", descricao: "Versão desatualizada do Java com múltiplas CVEs críticas.", cve: "CVE-2022-21476", recomendacao: "Atualizar Java para a versão LTS mais recente (Java 21+)." },
        { pattern: /winrar\s+[0-5]\.|winrar.*[0-5]\./i, risco: "alto", descricao: "Versão antiga do WinRAR com CVE-2023-38831 (execução de código via RAR malicioso).", cve: "CVE-2023-38831", recomendacao: "Atualizar WinRAR para a versão 6.23 ou superior." },
        { pattern: /teamviewer\s+([1-9]|1[0-4])\./i, risco: "alto", descricao: "Versão antiga do TeamViewer com vulnerabilidades de autenticação conhecidas.", cve: "CVE-2020-13699", recomendacao: "Atualizar TeamViewer para a versão 15+ mais recente." },
        { pattern: /putty\s+0\.(7[0-7]|[0-6])/i, risco: "alto", descricao: "Versão antiga do PuTTY com CVE-2024-31497 (chave ECDSA comprometida).", cve: "CVE-2024-31497", recomendacao: "Atualizar PuTTY para a versão 0.81 ou superior." },
        { pattern: /7-zip\s+[0-9]\.([0-9]|1[0-9])\b/i, risco: "medio", descricao: "Versão antiga do 7-Zip com vulnerabilidades de parsing de arquivos.", cve: null, recomendacao: "Atualizar o 7-Zip para a versão mais recente." },
        { pattern: /vlc\s+[12]\./i, risco: "medio", descricao: "Versão antiga do VLC com vulnerabilidades de parsing de mídia.", cve: null, recomendacao: "Atualizar VLC para a versão 3.x mais recente." },
      ];

      for (const s of softwareLista) {
        for (const h of heuristicas) {
          const testStr = `${s.nome} ${s.versao || ""}`;
          if (h.pattern.test(testStr)) {
            vulnerabilidades.push({
              software: s.nome,
              versao: s.versao || "desconhecida",
              risco: h.risco,
              descricao: h.descricao,
              cve: h.cve,
              recomendacao: h.recomendacao,
            });
            break;
          }
        }
      }

      const criticos = vulnerabilidades.filter((v) => v.risco === "critico").length;
      const total = vulnerabilidades.length;
      if (total === 0) {
        resumo = "Nenhum software reconhecidamente vulnerável identificado pela análise heurística. Configure a ANTHROPIC_API_KEY para análise completa com IA.";
      } else {
        resumo = `${total} software${total !== 1 ? "s" : ""} com risco identificado${criticos > 0 ? ` (${criticos} crítico${criticos !== 1 ? "s" : ""})` : ""}. Análise heurística — configure ANTHROPIC_API_KEY para varredura completa com IA.`;
      }
    }

    // Ordenar por severidade
    const ordemRisco: Record<string, number> = { critico: 0, alto: 1, medio: 2, baixo: 3 };
    vulnerabilidades.sort((a, b) => (ordemRisco[a.risco] ?? 4) - (ordemRisco[b.risco] ?? 4));

    const resultado = {
      vulnerabilidades,
      resumo,
      total: vulnerabilidades.length,
      criticos: vulnerabilidades.filter((v) => v.risco === "critico").length,
      altos: vulnerabilidades.filter((v) => v.risco === "alto").length,
      geradoEm: new Date().toISOString(),
      semIA,
    };

    try {
      await redis.set(cacheKey, JSON.stringify(resultado), "EX", 6 * 3600);
    } catch {}

    return reply.send({ ...resultado, cached: false });
  });
};
