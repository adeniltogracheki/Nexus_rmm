import { Server as SocketServer } from "socket.io";
import type { FastifyInstance } from "fastify";
import Redis from "ioredis";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { redis } from "../redis";
import { config } from "../config";
import { lerAccess } from "../auth/jwt";
import { comTenant } from "../db/tenant";
import { maquinas } from "../db/schema";
import { obterSocketAgente } from "./agent";
import { registrarTerminalSession, obterTerminalSession, removerTerminalSession, obterTodasSessions } from "./sessions";
import { grupoNoEscopo } from "../escopo";
import { temPermissao } from "../permissoes";

/** Origins permitidas para conexões Socket.io do painel admin. */
const ALLOWED_ORIGINS = new Set(
  [config.PUBLIC_URL, config.APP_URL].filter(Boolean)
);

let ioInstance: SocketServer | null = null;
let redisSub: Redis | null = null;

export function obterIoInstance(): SocketServer | null {
  return ioInstance;
}

function extrairNexusCookie(cookieHeader: string): string | null {
  const match = cookieHeader.match(/nexus_at=([^;]+)/);
  return (match && match[1]) ?? null;
}

export function configurarSocketAdmin(app: FastifyInstance): SocketServer {
  if (ioInstance) {
    return ioInstance;
  }

  // Inicializa o Socket.io atrelado ao servidor HTTP do Fastify principal.
  // CORS restrito às origens da aplicação para prevenir CSRF via Socket.io.
  const io = new SocketServer(app.server, {
    cors: {
      origin: (origin, cb) => {
        // Permite conexões sem origin (mesmo host / ferramentas server-side).
        if (!origin || ALLOWED_ORIGINS.has(origin)) return cb(null, true);
        cb(new Error(`Origin bloqueada: ${origin}`), false);
      },
      credentials: true,
    },
  });

  ioInstance = io;

  const adminNamespace = io.of("/admin");

  // Middleware de autenticação baseado em JWT + validação de origin (anti-CSRF).
  adminNamespace.use(async (socket, next) => {
    try {
      // Rejeitar handshake de origins não permitidas (prevenção de CSRF via WebSocket).
      const origin = socket.handshake.headers.origin;
      if (origin && !ALLOWED_ORIGINS.has(origin)) {
        return next(new Error("Origin não autorizada"));
      }

      const cookieHeader = socket.request.headers.cookie;
      let token = cookieHeader ? extrairNexusCookie(cookieHeader) : null;

      // Permite passar o token via payload de autenticação (comum em testes automatizados)
      if (!token && socket.handshake.auth?.token) {
        token = socket.handshake.auth.token;
      }

      if (!token) {
        return next(new Error("Não autenticado"));
      }

      const claims = await lerAccess(token);
      socket.data = {
        tenantId: claims.tenantId,
        userId: claims.userId,
        papel: claims.papel,
        empresas: claims.empresas ?? null,
        permissoes: claims.permissoes ?? null,
      };

      next();
    } catch (err) {
      next(new Error("Sessão expirada ou inválida"));
    }
  });

  adminNamespace.on("connection", (socket) => {
    const { tenantId, userId } = socket.data as { tenantId: string; userId: string };
    app.log.info({ tenantId, userId }, "Administrador conectado no gateway Socket.io");

    // Junta o socket a uma sala exclusiva do seu tenant para isolamento RLS
    socket.join(`tenant:${tenantId}`);

    // Início de sessão de terminal interativo
    socket.on("admin:terminal-start", async (payload: { machineId: string; shell: string }) => {
      const { machineId, shell } = payload;
      app.log.info({ machineId, shell, userId }, "admin:terminal-start recebido");
      
      if (!machineId) {
        app.log.warn({ userId }, "Tentativa de abrir terminal com machineId inválido");
        socket.emit("admin:terminal-error", { error: "machineId inválido" });
        return;
      }

      if (!temPermissao({ papel: socket.data.papel, permissoes: socket.data.permissoes } as any, "terminal")) {
        app.log.warn({ userId, machineId }, "Tentativa de abrir terminal recusada: sem permissão");
        socket.emit("admin:terminal-error", { error: "Sem permissão para abrir o terminal" });
        return;
      }

      try {
        const maquina = await comTenant(tenantId, async (tdb) => {
          const rows = await tdb.select().from(maquinas).where(eq(maquinas.id, machineId)).limit(1);
          return rows[0];
        });

        if (!maquina) {
          app.log.warn({ machineId, tenantId }, "Máquina não encontrada no tenant para abertura de terminal");
          socket.emit("admin:terminal-error", { error: "Máquina não encontrada" });
          return;
        }

        // Escopo por empresa: usuário restrito não abre terminal fora das empresas dele.
        const claimsEscopo = { userId, tenantId, papel: socket.data.papel, mfa: true, empresas: socket.data.empresas ?? null };
        if (!(await grupoNoEscopo(claimsEscopo, maquina.grupoId))) {
          socket.emit("admin:terminal-error", { error: "Máquina fora do seu escopo de empresas" });
          return;
        }

        const agentSocket = obterSocketAgente(machineId);
        if (!agentSocket) {
          app.log.warn({ machineId }, "Tentativa de abrir terminal falhou: Agente offline");
          socket.emit("admin:terminal-error", { error: "Agente offline ou não conectado" });
          return;
        }

        const sessionId = crypto.randomUUID();
        registrarTerminalSession(sessionId, {
          adminSocketId: socket.id,
          agentSocketId: agentSocket.id,
          machineId,
        });

        app.log.info({ machineId, sessionId, agentSocketId: agentSocket.id }, "Emitindo server:terminal-start para o agente");
        agentSocket.emit("server:terminal-start", { sessionId, shell });
        socket.emit("admin:terminal-started", { sessionId, machineId });
      } catch (err: any) {
        app.log.error({ err, machineId }, "Erro crítico no admin:terminal-start");
        socket.emit("admin:terminal-error", { error: err.message || "Erro interno ao iniciar terminal" });
      }
    });

    // Entrada de caracteres do terminal
    socket.on("admin:terminal-input", (payload: { sessionId: string; data: string }) => {
      const { sessionId, data } = payload;
      const session = obterTerminalSession(sessionId);
      if (session && session.adminSocketId === socket.id) {
        const agentSocket = obterSocketAgente(session.machineId);
        if (agentSocket) {
          agentSocket.emit("server:terminal-input", { sessionId, data });
        }
      } else {
        app.log.warn({ sessionId, socketId: socket.id }, "Entrada de terminal recebida para sessão inválida ou não autorizada");
      }
    });

    // Redimensionamento do terminal (cols/rows) → repassa pro PTY do agente
    socket.on("admin:terminal-resize", (payload: { sessionId: string; cols: number; rows: number }) => {
      const { sessionId, cols, rows } = payload || ({} as { sessionId: string; cols: number; rows: number });
      const session = obterTerminalSession(sessionId);
      if (session && session.adminSocketId === socket.id) {
        const agentSocket = obterSocketAgente(session.machineId);
        if (agentSocket) {
          agentSocket.emit("server:terminal-resize", { sessionId, cols, rows });
        }
      }
    });

    // Encerramento manual de sessão de terminal
    socket.on("admin:terminal-stop", (payload: { sessionId: string }) => {
      const { sessionId } = payload;
      app.log.info({ sessionId, userId }, "admin:terminal-stop recebido");
      const session = obterTerminalSession(sessionId);
      if (session && session.adminSocketId === socket.id) {
        const agentSocket = obterSocketAgente(session.machineId);
        if (agentSocket) {
          agentSocket.emit("server:terminal-stop", { sessionId });
        }
        removerTerminalSession(sessionId);
      }
    });

    // Multi-monitor: solicitar lista de monitores da máquina
    socket.on("admin:list-monitors", (payload: { machineId: string }) => {
      const { machineId } = payload || {};
      if (!machineId) return;
      const agentSocket = obterSocketAgente(machineId);
      if (agentSocket) {
        agentSocket.emit("server:list-monitors", {});
      }
    });

    // Multi-monitor: selecionar monitor ativo na sessão de tela
    socket.on("admin:screen-select-monitor", (payload: { machineId: string; monitorIdx: number }) => {
      const { machineId, monitorIdx } = payload || {};
      if (!machineId) return;
      const agentSocket = obterSocketAgente(machineId);
      if (agentSocket) {
        agentSocket.emit("server:screen-select-monitor", { monitorIdx: Number(monitorIdx) || 0 });
      }
    });

    socket.on("disconnect", () => {
      app.log.info({ tenantId, userId }, "Administrador desconectado do socket");
      // Limpa sessões de terminal associadas a este administrador
      for (const [sessionId, session] of obterTodasSessions().entries()) {
        if (session.adminSocketId === socket.id) {
          const agentSocket = obterSocketAgente(session.machineId);
          if (agentSocket) {
            agentSocket.emit("server:terminal-stop", { sessionId });
          }
          removerTerminalSession(sessionId);
        }
      }
    });
  });

  // Inicializa o Subscriber do Redis para receber e retransmitir eventos de presença
  redisSub = redis.duplicate();
  redisSub.connect().then(() => {
    redisSub!.subscribe("rmm:presence", (err) => {
      if (err) {
        app.log.error({ err }, "Erro ao assinar canal de presença do Redis");
      } else {
        app.log.info("Inscrito no canal rmm:presence do Redis para gateway administrativo");
      }
    });

    redisSub!.on("message", (channel, message) => {
      if (channel === "rmm:presence") {
        try {
          const { machineId, tenantId, online, vistoEm, versaoAgente } = JSON.parse(message);

          // Transmite o evento APENAS para os administradores da sala daquele tenant (RLS lógico)
          adminNamespace.to(`tenant:${tenantId}`).emit("admin:machine-presence", {
            machineId,
            tenantId,
            online,
            vistoEm,
            versaoAgente,
          });

        } catch (err) {
          app.log.error({ err }, "Erro ao tratar mensagem Pub/Sub do Redis");
        }
      }
    });
  }).catch((err) => {
    app.log.error({ err }, "Erro ao abrir conexão de Redis Subscriber");
  });

  return io;
}

export async function encerrarSocketAdmin(): Promise<void> {
  if (redisSub) {
    redisSub.disconnect();
    redisSub = null;
  }
  if (ioInstance) {
    ioInstance.close();
    ioInstance = null;
  }
}
