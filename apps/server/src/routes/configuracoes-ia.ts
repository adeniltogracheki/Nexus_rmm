/**
 * configuracoes-ia.ts — Endpoints de configuração do sistema de alertas + IA remediação.
 * Rotas:
 *   GET/PUT  /api/config/notificacoes             — canais (email, Telegram, WhatsApp, webhook)
 *   GET/PUT  /api/config/regras-alerta            — thresholds de CPU/RAM/disco
 *   GET      /api/remediacoes                     — log de remediações IA do tenant
 *   PATCH    /api/maquinas/:id/ia                 — criticidade + ia toggle + ações permitidas
 *   POST     /api/config/telegram/test            — envia mensagem de teste no Telegram
 *   POST     /api/config/telegram/register-webhook — registra webhook automático no Telegram
 *   POST     /api/config/email/test               — envia e-mail de teste
 *   GET      /api/remediacao-aprovacao            — lista aprovações pendentes
 *   POST     /api/remediacao-aprovacao/:id/aprovar   — aprova via web
 *   POST     /api/remediacao-aprovacao/:id/recusar   — recusa via web
 *   POST     /api/config/whatsapp/register-webhook  — registra webhook WA na Evolution API
 */
import type { FastifyPluginAsync } from "fastify";
import { eq, desc } from "drizzle-orm";
import nodemailer from "nodemailer";
import { comTenant } from "../db/tenant";
import { notificacoesConfig, regrasAlerta, remediacoesIa, maquinas, remediacoesAprovacao } from "../db/schema";
import { redis } from "../redis";
import { CATALOGO_SEGURO } from "../monitoramento/remediacaoIa";
import { processarRespostaAprovacao, listarAprovacoesPendentes } from "../monitoramento/aprovacaoRemediacao";
import { config } from "../config";
import crypto from "node:crypto";

export const configuracoesIaRoutes: FastifyPluginAsync = async (app) => {

  // ── Notificações: GET ────────────────────────────────────────────────────────
  app.get("/api/config/notificacoes", {
    preHandler: [app.requireAuth, app.requireMfa],
  }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const rows = await comTenant(tenantId, (tdb) =>
      tdb.select().from(notificacoesConfig).where(eq(notificacoesConfig.tenantId, tenantId)).limit(1),
    );
    // Nunca retorna senhas/tokens completos — mascarar
    const cfg = rows[0];
    if (!cfg) return reply.send({});
    return reply.send({
      ...cfg,
      smtpPass: cfg.smtpPass ? "●●●●●●●●" : null,
      telegramBotToken: cfg.telegramBotToken ? `${cfg.telegramBotToken.slice(0, 8)}●●●●` : null,
    });
  });

  // ── Notificações: PUT ────────────────────────────────────────────────────────
  app.put("/api/config/notificacoes", {
    preHandler: [app.requireAuth, app.requireMfa, app.requireAdmin],
  }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const body = req.body as Record<string, unknown>;

    // Remove campos mascarados para não sobrescrever com placeholder
    const update: Record<string, unknown> = {};
    const campos = [
      "webhookUrl", "formato", "telegramChatId", "minSeveridade", "ativo", "relatorioSemanal",
      "emailAtivo", "smtpHost", "smtpPort", "smtpSeguro", "smtpUser", "smtpFrom", "emailDestinatarios",
      "telegramAtivo", "telegramChatIdBot", "notifCritico", "notifAviso", "notifOffline",
    ] as const;
    for (const c of campos) {
      if (body[c] !== undefined) update[c] = body[c];
    }
    // Só atualiza senhas/tokens se veio um valor real (não o placeholder mascarado)
    if (body.smtpPass && !String(body.smtpPass).includes("●")) update.smtpPass = body.smtpPass;
    if (body.telegramBotToken && !String(body.telegramBotToken).includes("●")) update.telegramBotToken = body.telegramBotToken;

    const existente = await comTenant(tenantId, (tdb) =>
      tdb.select({ id: notificacoesConfig.tenantId }).from(notificacoesConfig).where(eq(notificacoesConfig.tenantId, tenantId)).limit(1),
    );
    if (existente.length === 0) {
      await comTenant(tenantId, (tdb) =>
        tdb.insert(notificacoesConfig).values({ tenantId, ...update } as any),
      );
    } else {
      await comTenant(tenantId, (tdb) =>
        tdb.update(notificacoesConfig).set(update as any).where(eq(notificacoesConfig.tenantId, tenantId)),
      );
    }
    return reply.send({ ok: true });
  });

  // ── Teste Telegram ────────────────────────────────────────────────────────────
  app.post("/api/config/telegram/test", {
    preHandler: [app.requireAuth, app.requireMfa, app.requireAdmin],
  }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const body = req.body as { botToken?: string; chatId?: string };

    // Usa os valores fornecidos ou os que estão no banco
    let botToken = body.botToken;
    let chatId   = body.chatId;
    if (!botToken || !chatId) {
      const rows = await comTenant(tenantId, (tdb) =>
        tdb.select().from(notificacoesConfig).where(eq(notificacoesConfig.tenantId, tenantId)).limit(1),
      );
      botToken = botToken || rows[0]?.telegramBotToken || "";
      chatId   = chatId   || rows[0]?.telegramChatIdBot || "";
    }
    if (!botToken || !chatId) return reply.code(400).send({ erro: "Bot Token e Chat ID são obrigatórios" });

    try {
      const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: "✅ *Nexus RMM* — Configuração de Telegram confirmada! Alertas serão enviados aqui.", parse_mode: "Markdown" }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await r.json() as { ok: boolean; description?: string };
      if (!data.ok) return reply.code(400).send({ erro: data.description ?? "Telegram recusou a mensagem" });
      return reply.send({ ok: true });
    } catch (err: any) {
      return reply.code(500).send({ erro: String(err?.message ?? "Erro de rede") });
    }
  });

  // ── Teste E-mail ──────────────────────────────────────────────────────────────
  app.post("/api/config/email/test", {
    preHandler: [app.requireAuth, app.requireMfa, app.requireAdmin],
  }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const rows = await comTenant(tenantId, (tdb) =>
      tdb.select().from(notificacoesConfig).where(eq(notificacoesConfig.tenantId, tenantId)).limit(1),
    );
    const cfg = rows[0];
    if (!cfg?.emailAtivo || !cfg.smtpHost || !cfg.smtpFrom || !cfg.emailDestinatarios)
      return reply.code(400).send({ erro: "Configure o e-mail antes de testar" });

    try {
      const transporter = nodemailer.createTransport({
        host: cfg.smtpHost, port: cfg.smtpPort ?? 587, secure: cfg.smtpSeguro,
        auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass ?? "" } : undefined,
        connectionTimeout: 8000,
      });
      await transporter.sendMail({
        from: cfg.smtpFrom,
        to: cfg.emailDestinatarios,
        subject: "✅ Nexus RMM — Teste de e-mail",
        html: `<p style="font-family:system-ui">Configuração de e-mail confirmada! Alertas críticos serão enviados aqui pelo Nexus RMM.</p>`,
      });
      return reply.send({ ok: true });
    } catch (err: any) {
      return reply.code(500).send({ erro: String(err?.message ?? "Erro SMTP") });
    }
  });

  // ── Regras de alerta: GET ────────────────────────────────────────────────────
  app.get("/api/config/regras-alerta", {
    preHandler: [app.requireAuth, app.requireMfa],
  }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const rows = await comTenant(tenantId, (tdb) =>
      tdb.select().from(regrasAlerta).where(eq(regrasAlerta.tenantId, tenantId)).limit(1),
    );
    // Defaults se não configurado
    return reply.send(rows[0] ?? {
      cpuLimitePct: 90, cpuJanelaMin: 2,
      ramLimitePct: 90, ramJanelaMin: 2,
      discoLivreMinPct: 10, offlineToleranciaMin: 5,
      iaRemediaCaoGlobal: false,
    });
  });

  // ── Regras de alerta: PUT ─────────────────────────────────────────────────────
  app.put("/api/config/regras-alerta", {
    preHandler: [app.requireAuth, app.requireMfa, app.requireAdmin],
  }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const body = req.body as Partial<typeof regrasAlerta.$inferInsert>;

    const existente = await comTenant(tenantId, (tdb) =>
      tdb.select({ id: regrasAlerta.tenantId }).from(regrasAlerta).where(eq(regrasAlerta.tenantId, tenantId)).limit(1),
    );
    if (existente.length === 0) {
      await comTenant(tenantId, (tdb) =>
        tdb.insert(regrasAlerta).values({ tenantId, ...body } as any),
      );
    } else {
      await comTenant(tenantId, (tdb) =>
        tdb.update(regrasAlerta).set(body as any).where(eq(regrasAlerta.tenantId, tenantId)),
      );
    }
    // Invalida cache Redis das regras
    await redis.del(`regras-alerta:${tenantId}`);
    return reply.send({ ok: true });
  });

  // ── Log de remediações IA ─────────────────────────────────────────────────────
  app.get("/api/remediacoes", {
    preHandler: [app.requireAuth, app.requireMfa],
  }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const q = req.query as { limit?: string; maquinaId?: string };
    const limit = Math.min(Number(q.limit ?? 20), 100);

    const rows = await comTenant(tenantId, (tdb) => {
      const base = tdb.select({
        id: remediacoesIa.id,
        maquinaId: remediacoesIa.maquinaId,
        maquinaNome: maquinas.apelido,
        maquinaHostname: maquinas.hostname,
        triggerDescricao: remediacoesIa.triggerDescricao,
        acoesExecutadas: remediacoesIa.acoesExecutadas,
        metricasAntes: remediacoesIa.metricasAntes,
        metricasDepois: remediacoesIa.metricasDepois,
        status: remediacoesIa.status,
        duracaoMs: remediacoesIa.duracaoMs,
        criadoEm: remediacoesIa.criadoEm,
      })
        .from(remediacoesIa)
        .leftJoin(maquinas, eq(remediacoesIa.maquinaId, maquinas.id))
        .orderBy(desc(remediacoesIa.criadoEm))
        .limit(limit);
      if (q.maquinaId) return base.where(eq(remediacoesIa.maquinaId, q.maquinaId));
      return base;
    });
    return reply.send({ remediacoes: rows, total: rows.length });
  });

  // ── Catálogo de ações ─────────────────────────────────────────────────────────
  app.get("/api/config/ia/catalogo", {
    preHandler: [app.requireAuth],
  }, async (_req, reply) => {
    return reply.send({
      acoes: Object.entries(CATALOGO_SEGURO).map(([id, a]) => ({
        id, desc: a.desc, triggers: a.triggers,
      })),
    });
  });

  // ── Criticidade + IA por máquina ──────────────────────────────────────────────
  app.patch("/api/maquinas/:id/ia", {
    preHandler: [app.requireAuth, app.requireMfa, app.requireOperador],
  }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const { id } = req.params as { id: string };
    const body = req.body as {
      criticidade?: string;
      iaRemediacao?: boolean;
      iaAcoesPermitidas?: string[];
    };

    const update: Record<string, unknown> = {};
    const criticidadesValidas = ["operacional", "importante", "critico", "missao_critica"];
    if (body.criticidade !== undefined) {
      if (!criticidadesValidas.includes(body.criticidade))
        return reply.code(400).send({ erro: "Criticidade inválida" });
      update.criticidade = body.criticidade;
    }
    if (body.iaRemediacao !== undefined) update.iaRemediacao = body.iaRemediacao;
    if (body.iaAcoesPermitidas !== undefined) {
      const validas = body.iaAcoesPermitidas.filter((a) => a in CATALOGO_SEGURO);
      update.iaAcoesPermitidas = validas;
    }

    await comTenant(tenantId, (tdb) =>
      tdb.update(maquinas).set(update as any).where(eq(maquinas.id, id)),
    );
    return reply.send({ ok: true });
  });

  // ── Registro automático de webhook do Telegram ────────────────────────────
  app.post("/api/config/telegram/register-webhook", {
    preHandler: [app.requireAuth, app.requireMfa, app.requireAdmin],
  }, async (req, reply) => {
    const { tenantId } = req.auth!;

    const rows = await comTenant(tenantId, (tdb) =>
      tdb.select({ botToken: notificacoesConfig.telegramBotToken, secret: notificacoesConfig.telegramWebhookSecret })
        .from(notificacoesConfig).where(eq(notificacoesConfig.tenantId, tenantId)).limit(1),
    );
    const botToken = rows[0]?.botToken;
    if (!botToken) return reply.code(400).send({ erro: "Configure o Bot Token do Telegram primeiro" });

    // Gera secret para validar requests futuros
    let secret = rows[0]?.secret;
    if (!secret) {
      secret = crypto.randomBytes(24).toString("hex");
      await comTenant(tenantId, (tdb) =>
        tdb.update(notificacoesConfig)
          .set({ telegramWebhookSecret: secret })
          .where(eq(notificacoesConfig.tenantId, tenantId)),
      );
    }

    const webhookUrl = `${config.PUBLIC_URL}/api/webhooks/telegram/${tenantId}`;
    try {
      const r = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: webhookUrl, secret_token: secret }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await r.json() as { ok: boolean; description?: string };
      if (!data.ok) return reply.code(400).send({ erro: data.description ?? "Telegram recusou o webhook" });
      return reply.send({ ok: true, webhookUrl });
    } catch (err: any) {
      return reply.code(500).send({ erro: String(err?.message ?? "Erro de rede") });
    }
  });

  // ── Registro automático de webhook do WhatsApp (Evolution API) ────────────
  app.post("/api/config/whatsapp/register-webhook", {
    preHandler: [app.requireAuth, app.requireMfa, app.requireAdmin],
  }, async (req, reply) => {
    const { tenantId } = req.auth!;

    const cfgStr = await redis.get(`wa-config:${tenantId}`);
    if (!cfgStr) return reply.code(400).send({ erro: "Configure o WhatsApp antes de registrar o webhook" });

    const cfg = JSON.parse(cfgStr) as { apiUrl: string; instancia: string; apiKey: string };
    if (!cfg.apiUrl || !cfg.instancia) return reply.code(400).send({ erro: "URL e instância são obrigatórios" });

    const webhookUrl = `${config.PUBLIC_URL}/api/webhooks/whatsapp/${tenantId}`;
    try {
      const r = await fetch(`${cfg.apiUrl}/webhook/set/${cfg.instancia}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": cfg.apiKey },
        body: JSON.stringify({ webhook: { enabled: true, url: webhookUrl, events: ["MESSAGES_UPSERT"] } }),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        return reply.code(400).send({ erro: `Evolution API retornou ${r.status}: ${txt.slice(0, 100)}` });
      }
      return reply.send({ ok: true, webhookUrl });
    } catch (err: any) {
      return reply.code(500).send({ erro: String(err?.message ?? "Erro de rede") });
    }
  });

  // ── Aprovações pendentes: listar ──────────────────────────────────────────
  app.get("/api/remediacao-aprovacao", {
    preHandler: [app.requireAuth, app.requireMfa],
  }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const aprovacoes = await listarAprovacoesPendentes(tenantId);
    return reply.send({ aprovacoes, total: aprovacoes.length });
  });

  // ── Aprovações: aprovar via web ───────────────────────────────────────────
  app.post("/api/remediacao-aprovacao/:id/aprovar", {
    preHandler: [app.requireAuth, app.requireMfa, app.requireOperador],
  }, async (req, reply) => {
    const { tenantId, userId } = req.auth!;
    const { id } = req.params as { id: string };

    // Verifica que o registro pertence ao tenant
    const rows = await comTenant(tenantId, (tdb) =>
      tdb.select({ codigo: remediacoesAprovacao.codigo })
        .from(remediacoesAprovacao).where(eq(remediacoesAprovacao.id, id)).limit(1),
    );
    if (!rows[0]) return reply.code(404).send({ erro: "Aprovação não encontrada" });

    const resultado = await processarRespostaAprovacao(
      rows[0].codigo,
      true,
      `web:${userId}`,
    );
    return reply.send(resultado);
  });

  // ── Aprovações: recusar via web ───────────────────────────────────────────
  app.post("/api/remediacao-aprovacao/:id/recusar", {
    preHandler: [app.requireAuth, app.requireMfa, app.requireOperador],
  }, async (req, reply) => {
    const { tenantId, userId } = req.auth!;
    const { id } = req.params as { id: string };

    const rows = await comTenant(tenantId, (tdb) =>
      tdb.select({ codigo: remediacoesAprovacao.codigo })
        .from(remediacoesAprovacao).where(eq(remediacoesAprovacao.id, id)).limit(1),
    );
    if (!rows[0]) return reply.code(404).send({ erro: "Aprovação não encontrada" });

    const resultado = await processarRespostaAprovacao(
      rows[0].codigo,
      false,
      `web:${userId}`,
    );
    return reply.send(resultado);
  });
};
