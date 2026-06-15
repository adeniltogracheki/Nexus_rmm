import https from "node:https";
import tls from "node:tls";
import { Server as SocketServer } from "socket.io";
import { eq, sql, and, notInArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { Ev, Heartbeat, CommandResult, AgentCommand, MachineInventoryPayload } from "@nexus/protocol";
import { config } from "../config";
import { redis } from "../redis";
import { maquinas, servicosWindows, inventarios, alertas, notificacoesConfig, metricasHistorico, presencaLog } from "../db/schema";
import { comTenant } from "../db/tenant";
import { obterIoInstance } from "./admin";
import { removerTerminalSession, obterTodasSessions } from "./sessions";
import { avaliarMetricas } from "../monitoramento/engine";

const ORDEM_SEV: Record<string, number> = { info: 0, aviso: 1, critico: 2 };

/** Bloqueia webhooks apontando para rede interna/loopback (anti-SSRF). true = bloquear. */
export function hostInternoBloqueado(urlStr: string): boolean {
  try {
    const h = new URL(urlStr).hostname.toLowerCase();
    if (h === "localhost" || h === "0.0.0.0" || h === "::1" || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")) return true;
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    return false;
  } catch {
    return true;
  }
}

/** Envia a notificação para o webhook configurado (Telegram/Slack/genérico). Best-effort. */
async function notificarExterno(tenantId: string, severidade: string, mensagem: string): Promise<void> {
  try {
    const cfg = (
      await comTenant(tenantId, (tdb) =>
        tdb.select().from(notificacoesConfig).where(eq(notificacoesConfig.tenantId, tenantId)).limit(1),
      )
    )[0];
    if (!cfg || !cfg.ativo || !cfg.webhookUrl) return;
    if ((ORDEM_SEV[severidade] ?? 0) < (ORDEM_SEV[cfg.minSeveridade] ?? 1)) return;
    if (!/^https?:\/\//i.test(cfg.webhookUrl)) return;
    if (hostInternoBloqueado(cfg.webhookUrl)) return;

    const icone = severidade === "critico" ? "🔴" : severidade === "aviso" ? "🟠" : "🔵";
    const texto = `${icone} Nexus RMM: ${mensagem}`;
    let body: string;
    if (cfg.formato === "telegram") {
      body = JSON.stringify({ chat_id: cfg.telegramChatId, text: texto });
    } else if (cfg.formato === "slack") {
      body = JSON.stringify({ text: texto });
    } else {
      body = JSON.stringify({ origem: "nexus-rmm", severidade, mensagem, texto, em: Date.now() });
    }
    await fetch(cfg.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    // notificação é best-effort
  }
}

/** Envia um texto direto ao webhook do tenant (sem filtro de severidade). Para relatórios. */
export async function enviarTextoWebhook(tenantId: string, texto: string): Promise<boolean> {
  try {
    const cfg = (
      await comTenant(tenantId, (tdb) =>
        tdb.select().from(notificacoesConfig).where(eq(notificacoesConfig.tenantId, tenantId)).limit(1),
      )
    )[0];
    if (!cfg || !cfg.ativo || !cfg.webhookUrl) return false;
    if (!/^https?:\/\//i.test(cfg.webhookUrl) || hostInternoBloqueado(cfg.webhookUrl)) return false;
    let body: string;
    if (cfg.formato === "telegram") body = JSON.stringify({ chat_id: cfg.telegramChatId, text: texto });
    else if (cfg.formato === "slack") body = JSON.stringify({ text: texto });
    else body = JSON.stringify({ origem: "nexus-rmm", texto, em: Date.now() });
    await fetch(cfg.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(8000) });
    return true;
  } catch {
    return false;
  }
}

/** Envia alerta via WhatsApp usando Evolution API (config salva no Redis). Best-effort. */
async function notificarWhatsApp(tenantId: string, severidade: string, mensagem: string): Promise<void> {
  try {
    const cfgStr = await redis.get(`wa-config:${tenantId}`);
    if (!cfgStr) return;
    const cfg = JSON.parse(cfgStr) as {
      ativo: boolean; apiUrl: string; instancia: string; apiKey: string; numero: string;
      alertaCritico: boolean; alertaOffline: boolean;
    };
    if (!cfg.ativo || !cfg.apiUrl || !cfg.instancia || !cfg.numero) return;
    if (severidade === "critico" && !cfg.alertaCritico) return;
    // alertaOffline é tratado como tipo "offline" mas chega com severidade "aviso"
    // Só envia aviso se for alerta de offline e alertaOffline estiver ativo
    if (severidade === "aviso" && !cfg.alertaOffline) return;

    const icone = severidade === "critico" ? "🔴" : severidade === "aviso" ? "🟠" : "🔵";
    const texto = `${icone} *Nexus RMM*\n${mensagem}\n\n_${new Date().toLocaleString("pt-BR")}_`;

    await fetch(`${cfg.apiUrl}/message/sendText/${cfg.instancia}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": cfg.apiKey },
      body: JSON.stringify({ number: cfg.numero, text: texto }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // notificação WhatsApp é best-effort — nunca derruba o fluxo principal
  }
}

/** Cria um alerta para o tenant (offline, watchdog, etc.) e dispara notificação externa. */
export async function criarAlerta(
  tenantId: string,
  maquinaId: string | null,
  tipo: string,
  severidade: "info" | "aviso" | "critico",
  mensagem: string,
): Promise<void> {
  try {
    const rows = await comTenant(tenantId, async (tdb) => {
      return tdb.insert(alertas).values({ tenantId, maquinaId, tipo, severidade, mensagem }).returning();
    });
    const novoAlerta = rows[0];

    // Emite em tempo real para todos os admins conectados neste tenant
    if (novoAlerta) {
      const io = obterIoInstance();
      io?.of("/admin").to(`tenant:${tenantId}`).emit("admin:nova-notificacao", {
        id: novoAlerta.id,
        tenantId: novoAlerta.tenantId,
        maquinaId: novoAlerta.maquinaId ?? null,
        tipo: novoAlerta.tipo,
        severidade: novoAlerta.severidade,
        mensagem: novoAlerta.mensagem,
        lida: false,
        criadoEm: novoAlerta.criadoEm.toISOString(),
      });
    }

    void notificarExterno(tenantId, severidade, mensagem);
    void notificarWhatsApp(tenantId, severidade, mensagem);
  } catch {
    // não derruba o gateway por causa de um alerta
  }
}

async function nomeMaquina(tenantId: string, machineId: string): Promise<string> {
  try {
    const m = (
      await comTenant(tenantId, (tdb) =>
        tdb
          .select({ apelido: maquinas.apelido, hostname: maquinas.hostname })
          .from(maquinas)
          .where(eq(maquinas.id, machineId))
          .limit(1),
      )
    )[0];
    return m?.apelido || m?.hostname || machineId;
  } catch {
    return machineId;
  }
}
import { obterOuCriarCa, obterOuCriarCertificadoServidor } from "../pki/ca";

export const pendingCommands = new Map<
  string,
  {
    resolve: (res: CommandResult) => void;
    reject: (err: any) => void;
    timer: NodeJS.Timeout;
  }
>();

export function obterSocketAgente(machineId: string) {
  if (!ioInstance) return null;
  for (const [_, socket] of ioInstance.of("/agent").sockets) {
    if (socket.data.machineId === machineId) {
      return socket;
    }
  }
  return null;
}

export async function enviarComandoAgente(
  machineId: string,
  cmd: AgentCommand
): Promise<CommandResult> {
  const socket = obterSocketAgente(machineId);
  if (!socket) {
    throw new Error("Agente offline ou não conectado");
  }

  return new Promise<CommandResult>((resolve, reject) => {
    // Comandos longos (terminal, transferência de arquivo) ganham mais tempo.
    const tipoLento = ["shell.run", "file.read", "file.write"].includes((cmd as { type?: string }).type || "");
    const timer = setTimeout(() => {
      pendingCommands.delete(cmd.commandId);
      reject(new Error("Timeout aguardando resposta do agente"));
    }, tipoLento ? 200000 : 20000);

    pendingCommands.set(cmd.commandId, { resolve, reject, timer });

    socket.emit("server:command", cmd);
  });
}

let httpsServerInstance: https.Server | null = null;
let ioInstance: SocketServer | null = null;

/**
 * Máquinas que receberam sinal de auto-update e devem reconectar em breve.
 * Módulo-level para que rotas HTTP também possam marcar (update manual).
 * Chave: machineId, Valor: timestamp do sinal. TTL: 3 minutos.
 */
const maquinasEmUpdateModulo = new Map<string, number>();

/** Marca uma máquina como "em processo de update" — suprime alerta offline. */
export function marcarEmUpdate(mId: string): void {
  maquinasEmUpdateModulo.set(mId, Date.now());
  setTimeout(() => maquinasEmUpdateModulo.delete(mId), 3 * 60 * 1000);
}

/** Verifica se uma máquina está marcada como em update (para uso externo). */
export function estaEmUpdate(mId: string): boolean {
  return maquinasEmUpdateModulo.has(mId);
}

export async function iniciarGatewayAgentes(app: FastifyInstance): Promise<https.Server> {
  if (httpsServerInstance) {
    return httpsServerInstance;
  }

  app.log.info("Inicializando PKI e CA interna...");
  const caBundle = obterOuCriarCa();
  
  // Emite certificado do servidor para o gateway (suporta localhost e DNS do servidor)
  const serverBundle = obterOuCriarCertificadoServidor([
    "localhost",
    "127.0.0.1",
    "sis.gmtec.tec.br",
    "rmm.gmtec.tec.br",
  ]);

  app.log.info({ porta: config.AGENT_GATEWAY_PORT }, "Subindo servidor HTTPS mTLS do Gateway de Agentes...");

  // Configuração do Servidor HTTPS com mTLS obrigatório
  const options: https.ServerOptions = {
    key: serverBundle.serverKeyPem,
    cert: serverBundle.serverCertPem,
    ca: caBundle.caCertPem,
    requestCert: true,
    rejectUnauthorized: true, // Rejeita clientes sem certificados assinados pela CA
  };

  const httpsServer = https.createServer(options);
  const io = new SocketServer(httpsServer, {
    cors: { origin: "*" },
    pingInterval: 25000,
    pingTimeout: 20000,
    maxHttpBufferSize: 16 * 1024 * 1024, // permite transferência de arquivos (até ~10MB + base64)
  });

  httpsServerInstance = httpsServer;
  ioInstance = io;

  const agentNamespace = io.of("/agent");

  // Middleware mTLS para o namespace /agent
  agentNamespace.use((socket, next) => {
    const req = socket.request;
    const tlsSocket = req.socket as tls.TLSSocket;
    
    // getPeerCertificate retorna o certificado do cliente na conexão TLS
    const cert = tlsSocket.getPeerCertificate?.();

    if (!cert || !cert.subject) {
      app.log.warn("Tentativa de conexão WebSocket recusada: Certificado de cliente ausente");
      return next(new Error("Certificado de cliente ausente"));
    }

    const machineId = cert.subject.CN;
    const tenantId = cert.subject.O;

    if (!machineId || !tenantId) {
      app.log.warn("Tentativa de conexão WebSocket recusada: Atributos CN ou O inválidos no certificado");
      return next(new Error("Atributos do certificado inválidos"));
    }

    // Salva na sessão do socket
    socket.data = { machineId, tenantId };
    next();
  });

  // Conexão dos agentes
  agentNamespace.on("connection", (socket) => {
    const { machineId, tenantId } = socket.data as { machineId: string; tenantId: string };
    const connectedAt = Date.now();
    // Só enviamos o sinal de update UMA VEZ por sessão para evitar loop de restart.
    // Se o update falhar, o agente reconecta e ganha uma nova sessão (novo flag).
    let updateSignaledNaConexao = false;
    // Se estava em update: limpa — reconexão bem-sucedida
    maquinasEmUpdateModulo.delete(machineId);
    app.log.info({ machineId, tenantId }, "Agente RMM conectado via mTLS");

    // Setup assíncrono em background para não bloquear o registro síncrono de listeners
    (async () => {
      try {
        // Captura IP público do agente (usado para WoL — localizar peer na mesma rede)
        const req = socket.request;
        const ipPublico =
          (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
          req.socket?.remoteAddress ||
          null;

        // 1. Atualiza Postgres (online = true, e desarquiva se necessário — agente vivo não está desativado)
        await comTenant(tenantId, async (tdb) => {
          await tdb
            .update(maquinas)
            .set({ online: true, vistoEm: new Date(), arquivada: false, arquivadaEm: null, ipPublico })
            .where(eq(maquinas.id, machineId));
          await tdb.insert(presencaLog).values({ tenantId, maquinaId: machineId, online: true });
        });

        // 2. Define no Redis (presença com TTL de 60 segundos)
        await redis.set(`maquina:${machineId}:online`, "true", "EX", 60);

        // 3. Publica status online via Redis Pub/Sub para o namespace /admin
        await redis.publish(
          "rmm:presence",
          JSON.stringify({
            machineId,
            tenantId,
            online: true,
            vistoEm: Date.now(),
          }),
        );
      } catch (err) {
        app.log.error({ err, machineId, tenantId }, "Erro ao registrar conexão do agente no RMM");
      }
    })();

    // Sincronização do inventário de serviços do Windows
    socket.on(Ev.ServiceInventory, async (payload) => {
      try {
        const { services } = payload as {
          machineId: string;
          services: Array<{
            Name: string;
            DisplayName: string;
            Status: string;
            StartType: string;
          }>;
        };

        if (!Array.isArray(services)) {
          app.log.warn({ machineId }, "Inventário de serviços inválido recebido (esperado array)");
          return;
        }

        app.log.info({ machineId, count: services.length }, "Recebido inventário de serviços do agente");

        await comTenant(tenantId, async (tdb) => {
          if (services.length > 0) {
            const chunkSize = 100;
            for (let i = 0; i < services.length; i += chunkSize) {
              const chunk = services.slice(i, i + chunkSize);
              const values = chunk.map((s) => ({
                maquinaId: machineId,
                nome: s.Name,
                displayName: s.DisplayName || null,
                estado: s.Status,
                tipoInicializacao: s.StartType,
                atualizadoEm: new Date(),
              }));

              await tdb
                .insert(servicosWindows)
                .values(values)
                .onConflictDoUpdate({
                  target: [servicosWindows.maquinaId, servicosWindows.nome],
                  set: {
                    displayName: sql`EXCLUDED.display_name`,
                    estado: sql`EXCLUDED.estado`,
                    tipoInicializacao: sql`EXCLUDED.tipo_inicializacao`,
                    atualizadoEm: new Date(),
                  },
                });
            }
          }

          const nomesRecebidos = services.map((s) => s.Name);
          if (nomesRecebidos.length > 0) {
            // Usar notInArray (parametrizado) em vez de sql.raw — previne SQL Injection
            // caso nomes de serviços contenham caracteres especiais.
            await tdb
              .delete(servicosWindows)
              .where(
                and(
                  eq(servicosWindows.maquinaId, machineId),
                  notInArray(servicosWindows.nome, nomesRecebidos),
                )
              );
          } else {
            await tdb
              .delete(servicosWindows)
              .where(eq(servicosWindows.maquinaId, machineId));
          }
        });
      } catch (err) {
        app.log.error({ err, machineId }, "Erro ao processar inventário de serviços");
      }
    });

    // Sincronização do inventário de sistema (hardware, SO, rede, software)
    socket.on(Ev.AgentInventory, async (payload) => {
      try {
        const parsed = MachineInventoryPayload.safeParse(payload);
        if (!parsed.success) {
          app.log.warn({ machineId, err: parsed.error }, "Inventário de máquina inválido recebido");
          return;
        }

        const { hardware, so, rede, software, tipoMaquina, macAddress } = parsed.data;
        app.log.info({ machineId, tipoMaquina }, "Recebido inventário de hardware e software do agente");

        await comTenant(tenantId, async (tdb) => {
          await tdb
            .insert(inventarios)
            .values({
              tenantId,
              maquinaId: machineId,
              hardware,
              so,
              rede,
              software,
              atualizadoEm: new Date(),
            })
            .onConflictDoUpdate({
              target: inventarios.maquinaId,
              set: {
                hardware,
                so,
                rede,
                software,
                atualizadoEm: new Date(),
              },
            });

          // Persiste tipo de dispositivo e MAC (para WoL) na tabela de máquinas
          const updates: Record<string, unknown> = {};
          if (tipoMaquina) updates.tipoMaquina = tipoMaquina;
          if (macAddress)  updates.macAddress  = macAddress;
          if (Object.keys(updates).length > 0) {
            await tdb.update(maquinas).set(updates).where(eq(maquinas.id, machineId));
          }
        });

        // Cache disco no Redis para amostragem de métricas
        try {
          const discos = (hardware as any)?.discos;
          if (Array.isArray(discos) && discos.length > 0) {
            const discosUsoPct = discos
              .filter((d: any) => d.tamanhoBytes > 0)
              .map((d: any) => ({
                caminho: d.caminho,
                usoPct: Math.round(((d.tamanhoBytes - d.livreBytes) / d.tamanhoBytes) * 100),
              }));
            await redis.set(`maquina:${machineId}:discos`, JSON.stringify(discosUsoPct), "EX", 86400);
          }
        } catch {
          // cache de disco é best-effort
        }

        // Saúde proativa: disco quase cheio (<10% livre) — cooldown 6h por disco.
        try {
          const discos = (hardware as { discos?: Array<{ caminho?: string; tamanhoBytes?: number; livreBytes?: number }> })?.discos || [];
          for (const d of discos) {
            const total = Number(d.tamanhoBytes) || 0;
            const livre = Number(d.livreBytes) || 0;
            if (total > 0 && livre / total < 0.1) {
              const ck = `alerta:disco:${machineId}:${d.caminho}`;
              if (await redis.set(ck, "1", "EX", 21600, "NX")) {
                const nome = await nomeMaquina(tenantId, machineId);
                const pct = Math.round((livre / total) * 100);
                await criarAlerta(tenantId, machineId, "disco", "critico", `Disco ${d.caminho} quase cheio (${pct}% livre) em "${nome}".`);
              }
            }
          }
        } catch {
          // saúde proativa é best-effort
        }
      } catch (err) {
        app.log.error({ err, machineId }, "Erro ao processar inventário de máquina");
      }
    });

    // Resultado de comando executado no agente
    socket.on(Ev.CommandResult, async (payload) => {
      try {
        const parsed = CommandResult.safeParse(payload);
        if (!parsed.success) {
          app.log.warn({ machineId, err: parsed.error }, "Resultado de comando inválido recebido");
          return;
        }

        const { commandId, status } = parsed.data;
        app.log.info({ machineId, commandId, status }, "Recebido resultado de comando do agente");

        const pending = pendingCommands.get(commandId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingCommands.delete(commandId);
          pending.resolve(parsed.data);
        }
      } catch (err) {
        app.log.error({ err, machineId }, "Erro ao processar resultado de comando");
      }
    });

    // Diagnóstico de falha no auto-update (agente 0.5.14+)
    socket.on("agent:update-error", (payload: { versaoAtual?: string; versaoAlvo?: string; erro?: string; stack?: string }) => {
      app.log.error(
        { machineId, versaoAtual: payload?.versaoAtual, versaoAlvo: payload?.versaoAlvo, erro: payload?.erro, stack: payload?.stack },
        "Falha no auto-update do agente — erro reportado pelo próprio agente"
      );
    });

    // Alerta do watchdog (serviço caiu e foi reiniciado, ou falhou)
    socket.on("agent:watchdog-alert", async (payload: { service?: string; acao?: string; erro?: string }) => {
      try {
        const service = payload?.service || "serviço";
        const nome = await nomeMaquina(tenantId, machineId);
        const falhou = payload?.acao === "FALHA";
        await criarAlerta(
          tenantId,
          machineId,
          "watchdog",
          falhou ? "critico" : "info",
          falhou
            ? `Watchdog: serviço "${service}" caiu e NÃO reiniciou em "${nome}".`
            : `Watchdog: serviço "${service}" caiu e foi reiniciado em "${nome}".`,
        );
      } catch (err) {
        app.log.error({ err, machineId }, "Erro ao processar watchdog-alert");
      }
    });

    // Métricas ao vivo (CPU/RAM) — guarda as últimas 30 amostras no Redis (TTL 2min).
    socket.on("agent:metrics", async (payload: { cpu?: number; ram?: number; em?: number }) => {
      try {
        const cpu = Number(payload?.cpu) || 0;
        const ram = Number(payload?.ram) || 0;
        const item = JSON.stringify({ cpu, ram, em: Number(payload?.em) || Date.now() });
        const key = `maquina:${machineId}:metricas`;
        await redis.lpush(key, item);
        await redis.ltrim(key, 0, 29);
        await redis.expire(key, 120);

        // Histórico: grava no Postgres no máximo a cada 5min (lock NX no Redis).
        const lock = await redis.set(`methist:lock:${machineId}`, "1", "EX", 300, "NX");
        if (lock) {
          const discosJson = await redis.get(`maquina:${machineId}:discos`);
          const discos = discosJson ? JSON.parse(discosJson) : null;
          await comTenant(tenantId, (tdb) =>
            tdb.insert(metricasHistorico).values({ tenantId, maquinaId: machineId, cpu, ram, disco: discos }),
          );
        }

        // Motor de alertas configurável: CPU/RAM/disco com janela de tempo e IA remediação.
        // Nome da máquina em cache Redis (5min) para evitar SELECT a cada evento de métrica.
        const discosRaw = await redis.get(`maquina:${machineId}:discos`);
        const discosMetrics = discosRaw
          ? (JSON.parse(discosRaw) as Array<{ caminho: string; usoPct: number }>)
          : undefined;
        let maqNomeCache = await redis.get(`maquina:${machineId}:nome`);
        if (!maqNomeCache) {
          maqNomeCache = await nomeMaquina(tenantId, machineId);
          void redis.set(`maquina:${machineId}:nome`, maqNomeCache, "EX", 300);
        }
        void avaliarMetricas(tenantId, machineId, maqNomeCache, { cpu, ram, discos: discosMetrics });
      } catch {
        // métricas são best-effort
      }
    });

    // Terminal interativo: saída de dados (stdout/stderr) do agente
    socket.on("agent:terminal-stdout", (payload: { sessionId: string; data: string }) => {
      const { sessionId, data } = payload;
      app.log.info({ sessionId, dataLength: data?.length }, "Recebido agent:terminal-stdout do agente");
      const session = obterTodasSessions().get(sessionId);
      if (session) {
        const io = obterIoInstance();
        if (io) {
          io.of("/admin").to(session.adminSocketId).emit("admin:terminal-stdout", { sessionId, data });
        }
      }
    });

    // Terminal interativo: encerramento do processo no agente
    socket.on("agent:terminal-exit", (payload: { sessionId: string; code?: number }) => {
      const { sessionId, code } = payload;
      app.log.info({ sessionId, code }, "Recebido agent:terminal-exit do agente");
      const session = obterTodasSessions().get(sessionId);
      if (session) {
        const io = obterIoInstance();
        if (io) {
          io.of("/admin").to(session.adminSocketId).emit("admin:terminal-exit", { sessionId, code });
        }
        removerTerminalSession(sessionId);
      }
    });

    // Relay: agente → admin (lista de monitores para seleção de tela)
    socket.on("agent:monitors-list", (payload: { monitores: Array<{ idx: number; w: number; h: number; x: number; y: number }> }) => {
      const io = obterIoInstance();
      if (io) {
        io.of("/admin").to(`tenant:${tenantId}`).emit("admin:monitors-list", {
          machineId,
          monitores: Array.isArray(payload?.monitores) ? payload.monitores : [],
        });
      }
    });

function compararVersoes(v1: string, v2: string): number {
  const parts1 = v1.split(".").map(Number);
  const parts2 = v2.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

    // Batimento de coração periódico (Heartbeat)
    socket.on(Ev.AgentHeartbeat, async (payload) => {
      const parsed = Heartbeat.safeParse(payload);
      if (!parsed.success) {
        app.log.warn({ machineId, err: parsed.error }, "Heartbeat do agente inválido recebido");
        return;
      }

      const { uptimeSegundos, versaoAgente } = parsed.data;
      app.log.debug({ machineId, uptimeSegundos, versaoAgente }, "Heartbeat recebido do agente RMM");

      try {
        // Renova presença no Redis
        await redis.set(`maquina:${machineId}:online`, "true", "EX", 60);

        // Atualiza vistoEm e versaoAgente no Postgres
        await comTenant(tenantId, async (tdb) => {
          await tdb
            .update(maquinas)
            .set({ vistoEm: new Date(), versaoAgente })
            .where(eq(maquinas.id, machineId));
        });

        // Publica versaoAgente via Pub/Sub para o painel atualizar em tempo real
        await redis.publish(
          "rmm:presence",
          JSON.stringify({ machineId, tenantId, online: true, vistoEm: Date.now(), versaoAgente }),
        );

        // Verifica se há atualização disponível para o agente.
        // Enviamos o sinal apenas UMA VEZ por sessão (updateSignaledNaConexao) e só
        // após o grace period — isso evita o loop de restart infinito se o auto-update
        // falhar: o agente reconecta, ganha nova sessão, e recebe novo sinal após grace.
        const segundosConectado = Math.floor((Date.now() - connectedAt) / 1000);
        if (
          !updateSignaledNaConexao &&
          compararVersoes(versaoAgente, config.AGENTE_VERSAO_PROD) < 0 &&
          segundosConectado >= config.AGENTE_UPDATE_GRACE_SECONDS
        ) {
          updateSignaledNaConexao = true;
          marcarEmUpdate(machineId);
          app.log.info(
            { machineId, versaoAtual: versaoAgente, versaoProd: config.AGENTE_VERSAO_PROD, segundosConectado },
            "Agente desatualizado detectado. Enviando sinal de atualização (1x por sessão)."
          );
          socket.emit(Ev.UpdateAvailable, {
            url: `${config.PUBLIC_URL}/agente/agent.js?t=${Date.now()}`,
            version: config.AGENTE_VERSAO_PROD,
          });
        }
      } catch (err) {
        app.log.error({ err, machineId }, "Erro ao atualizar heartbeat do agente");
      }
    });

    // Localização reportada pelo agente móvel (Android/tablet)
    socket.on("agent:location", async (payload) => {
      const lat  = typeof payload?.latitude  === "number" ? payload.latitude  : null;
      const lng  = typeof payload?.longitude === "number" ? payload.longitude : null;
      const acc  = typeof payload?.precisaoMetros === "number" ? payload.precisaoMetros : null;
      if (lat === null || lng === null) return; // ignora payload inválido silenciosamente

      try {
        await comTenant(tenantId, async (tdb) => {
          await tdb
            .update(maquinas)
            .set({ latitude: lat, longitude: lng, precisaoMetros: acc, localizacaoEm: new Date() })
            .where(eq(maquinas.id, machineId));
        });

        // Broadcast em tempo real para o painel
        const io = obterIoInstance();
        io?.of("/admin").to(`tenant:${tenantId}`).emit("admin:location-update", {
          machineId,
          latitude:       lat,
          longitude:      lng,
          precisaoMetros: acc,
          localizacaoEm:  new Date().toISOString(),
        });
      } catch (err) {
        app.log.error({ err, machineId }, "Erro ao salvar localização do agente");
      }
    });

    // Desconexão do agente
    socket.on("disconnect", async (reason) => {
      app.log.info({ machineId, tenantId, reason }, "Agente RMM desconectado");

      // Limpa sessões de terminal vinculadas a este socket do agente
      for (const [sessionId, session] of obterTodasSessions().entries()) {
        if (session.agentSocketId === socket.id) {
          const io = obterIoInstance();
          if (io) {
            io.of("/admin").to(session.adminSocketId).emit("admin:terminal-exit", { sessionId, code: 1006 });
          }
          removerTerminalSession(sessionId);
        }
      }

      try {
        // Verifica se há outro socket ativo para o mesmo machineId
        let outroSocketAtivo = false;
        if (ioInstance) {
          for (const [sId, s] of ioInstance.of("/agent").sockets) {
            if (s.data.machineId === machineId && sId !== socket.id) {
              outroSocketAtivo = true;
              break;
            }
          }
        }

        if (outroSocketAtivo) {
          app.log.info({ machineId, tenantId }, "Outro socket ativo encontrado para esta maquina. Mantendo status ONLINE.");
          return;
        }

        // 1. Remove presença no Redis
        await redis.del(`maquina:${machineId}:online`);

        // 2. Atualiza Postgres (online = false)
        await comTenant(tenantId, async (tdb) => {
          await tdb
            .update(maquinas)
            .set({ online: false, vistoEm: new Date() })
            .where(eq(maquinas.id, machineId));
          await tdb.insert(presencaLog).values({ tenantId, maquinaId: machineId, online: false });
        });

        // 2b. Gera alerta de máquina offline — mas NÃO se o agente se desconectou
        // para se atualizar (disconnect esperado). Nesse caso o alerta seria falso positivo.
        if (!maquinasEmUpdateModulo.has(machineId)) {
          const nome = await nomeMaquina(tenantId, machineId);
          await criarAlerta(tenantId, machineId, "offline", "aviso", `A máquina "${nome}" ficou offline.`);
        } else {
          app.log.info({ machineId }, "Disconnect esperado (update em curso) — alerta de offline suprimido.");
        }

        // 3. Publica status offline via Redis Pub/Sub para o namespace /admin
        await redis.publish(
          "rmm:presence",
          JSON.stringify({
            machineId,
            tenantId,
            online: false,
            vistoEm: Date.now(),
          }),
        );

      } catch (err) {
        app.log.error({ err, machineId, tenantId }, "Erro ao registrar desconexão do agente");
      }
    });
  });

  return new Promise((resolve, reject) => {
    httpsServer.listen(config.AGENT_GATEWAY_PORT, "0.0.0.0", () => {
      app.log.info({ porta: config.AGENT_GATEWAY_PORT }, "Gateway de Agentes HTTPS mTLS rodando!");
      resolve(httpsServer);
    });

    httpsServer.on("error", (err) => {
      reject(err);
    });
  });
}

export async function encerrarGatewayAgentes(): Promise<void> {
  if (ioInstance) {
    ioInstance.close();
    ioInstance = null;
  }
  if (httpsServerInstance) {
    await new Promise<void>((resolve) => {
      httpsServerInstance!.close(() => {
        resolve();
      });
    });
    httpsServerInstance = null;
  }
}
