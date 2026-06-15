import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { sql } from "drizzle-orm";
import { config } from "./config";
import { db } from "./db/index";
import { redis } from "./redis";
import { authPlugin } from "./auth/plugin";
import { authRoutes } from "./routes/auth";
import { enrollRoutes } from "./routes/enroll";
import { telaRoutes } from "./routes/tela";
import { gruposRoutes } from "./routes/grupos";
import { servicosRoutes } from "./routes/servicos";
import { inventarioRoutes } from "./routes/inventario";
import { relatoriosRoutes } from "./routes/relatorios";
import { alertasRoutes } from "./routes/alertas";
import { chamadosRoutes } from "./routes/chamados";
import { usuariosRoutes } from "./routes/usuarios";
import { metricasRoutes } from "./routes/metricas";
import { notificacoesRoutes } from "./routes/notificacoes";
import { tarefasRoutes } from "./routes/tarefas";
import { arquivosRoutes } from "./routes/arquivos";
import { segurancaRoutes } from "./routes/seguranca";
import { manutencoesRoutes } from "./routes/manutencoes";
import { healthRoutes } from "./routes/health";
import { dashboardRoutes } from "./routes/dashboard";
import { analyticsRoutes } from "./routes/analytics";
import { configuracoesIaRoutes } from "./routes/configuracoes-ia";
import { webhooksRoutes } from "./routes/webhooks";
import { planosRoutes } from "./routes/planos";
import { adminTenantsRoutes } from "./routes/admin-tenants";
import { signupRoutes } from "./routes/signup";
import { pagamentoRoutes } from "./routes/pagamento";
import { wolRoutes } from "./routes/wol";
import { agenteUpdateRoutes } from "./routes/agente-update";
import { registrarHooksSeguranca, carregarConfigSeguranca } from "./seguranca";
import { configurarSocketAdmin, encerrarSocketAdmin } from "./gateway/admin";
import { encerrarGatewayAgentes } from "./gateway/agent";

const isProd = config.NODE_ENV === "production";
const ALLOWED_ORIGINS = new Set([config.PUBLIC_URL, config.APP_URL].filter(Boolean));

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.LOG_LEVEL }, bodyLimit: 16 * 1024 * 1024 });

  // ── Segurança HTTP ─────────────────────────────────────────────────────────
  // A4: Headers de segurança (CSP, HSTS, X-Frame-Options, etc.)
  await app.register(helmet, {
    contentSecurityPolicy: isProd
      ? {
          directives: {
            defaultSrc:  ["'self'"],
            scriptSrc:   ["'self'"],
            styleSrc:    ["'self'", "'unsafe-inline'"],   // Tailwind inline styles
            imgSrc:      ["'self'", "data:"],
            connectSrc:  ["'self'", "wss:", "https:"],
            frameSrc:    ["'self'"],
            fontSrc:     ["'self'"],
            objectSrc:   ["'none'"],
            upgradeInsecureRequests: [],
          },
        }
      : false,
    hsts: isProd ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    frameguard: { action: "sameorigin" },
    xContentTypeOptions: true,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  });

  // A3: Rate-limit global — mais restritivo em rotas sensíveis (aplicado por rota)
  // Em @fastify/rate-limit v11 (Fastify 5), errorResponseBuilder faz `throw` do retorno.
  // O objeto precisa ter `statusCode` para Fastify não devolver 500 por default.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    errorResponseBuilder: (_req, ctx) => {
      const err = Object.assign(new Error("muitas requisições, aguarde um momento"), {
        statusCode: ctx.statusCode ?? 429,
        erro: "muitas requisições, aguarde um momento",
      });
      return err;
    },
  });

  // A1: Proteção CSRF via verificação de Origin em mutações HTTP.
  // Rotas públicas (webhook MP, instalar.ps1, healthz) usam prefixos fora de /api/auth
  // ou são GET — não são afetadas.
  app.addHook("preHandler", async (req, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    // Rotas de webhook (MP) e instaladores são publicamente chamadas por terceiros
    const path = req.url.split("?")[0];
    if (path === "/api/mp/webhook") return;  // verificação de assinatura própria

    const origin = req.headers.origin;
    // Sem origin = chamada server-side ou mesmo domínio (curl, agente, etc.) — permitir
    if (!origin) return;
    if (!ALLOWED_ORIGINS.has(origin)) {
      return reply.code(403).send({ erro: "origin não autorizada" });
    }
  });

  await carregarConfigSeguranca();
  registrarHooksSeguranca(app);

  app.addHook("onClose", async () => {
    await encerrarSocketAdmin();
    await encerrarGatewayAgentes();
  });

  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(enrollRoutes);
  await app.register(telaRoutes);
  await app.register(wolRoutes);
  await app.register(gruposRoutes);
  await app.register(servicosRoutes);
  await app.register(inventarioRoutes);
  await app.register(relatoriosRoutes);
  await app.register(alertasRoutes);
  await app.register(chamadosRoutes);
  await app.register(usuariosRoutes);
  await app.register(metricasRoutes);
  await app.register(notificacoesRoutes);
  await app.register(segurancaRoutes);
  await app.register(manutencoesRoutes);
  await app.register(planosRoutes);
  await app.register(adminTenantsRoutes);
  await app.register(signupRoutes);
  await app.register(pagamentoRoutes);
  await app.register(tarefasRoutes);
  await app.register(arquivosRoutes);
  await app.register(healthRoutes);
  await app.register(dashboardRoutes);
  await app.register(analyticsRoutes);
  await app.register(configuracoesIaRoutes);
  await app.register(webhooksRoutes);
  await app.register(agenteUpdateRoutes);

  app.get("/healthz", async () => ({
    status: "ok",
    uptimeSegundos: Math.floor(process.uptime()),
  }));

  app.get("/readyz", async (_req, reply) => {
    const checks = { postgres: false, redis: false };
    try {
      await db.execute(sql`select 1`);
      checks.postgres = true;
    } catch (err) {
      app.log.error({ err }, "readyz: Postgres indisponível");
    }
    try {
      const pong = await redis.ping();
      checks.redis = pong === "PONG";
    } catch (err) {
      app.log.error({ err }, "readyz: Redis indisponível");
    }
    const ready = checks.postgres && checks.redis;
    reply.code(ready ? 200 : 503);
    return { ready, checks };
  });

  configurarSocketAdmin(app);

  await app.ready();
  return app;
}

