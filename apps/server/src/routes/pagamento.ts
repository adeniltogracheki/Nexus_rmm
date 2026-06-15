import type { FastifyPluginAsync } from "fastify";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import crypto from "node:crypto";
import { db } from "../db";
import { tenants, usuarios } from "../db/schema";
import { config } from "../config";
import { PLANOS } from "../planos";
import { limparCachePlano } from "../plano-guard";
import { emailPagamentoConfirmado } from "../platform-email";

const PLANOS_PAGAVEIS = ["essencial", "pro"] as const;

export const pagamentoRoutes: FastifyPluginAsync = async (app) => {
  // Indica se a cobrança está ativa (pra UI mostrar os botões).
  app.get("/api/pagamento/status", { preHandler: [app.requireAuth] }, async (_req, reply) => {
    return reply.send({ ativo: !!config.MP_ACCESS_TOKEN });
  });

  // Cria um checkout do Mercado Pago para um plano.
  app.post("/api/checkout", { preHandler: [app.requireAuth] }, async (req, reply) => {
    if (!config.MP_ACCESS_TOKEN) return reply.code(503).send({ erro: "pagamento não configurado" });
    const p = z.object({ plano: z.enum(PLANOS_PAGAVEIS) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ erro: "plano inválido para checkout" });
    const { tenantId } = req.auth!;
    const info = PLANOS[p.data.plano];
    const pref = {
      items: [{ title: `Nexus RMM - Plano ${info.nome}`, quantity: 1, unit_price: info.precoMes, currency_id: "BRL" }],
      external_reference: `${tenantId}:${p.data.plano}`,
      back_urls: { success: `${config.APP_URL}/painel`, failure: `${config.APP_URL}/painel`, pending: `${config.APP_URL}/painel` },
      auto_return: "approved",
      notification_url: `${config.APP_URL}/api/mp/webhook`,
    };
    try {
      const r = await fetch("https://api.mercadopago.com/checkout/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.MP_ACCESS_TOKEN}` },
        body: JSON.stringify(pref),
      });
      const j = (await r.json()) as any;
      if (!r.ok || !j.init_point) { app.log.error({ status: r.status, j }, "MP preference falhou"); return reply.code(502).send({ erro: "falha ao criar checkout" }); }
      return reply.send({ url: j.init_point });
    } catch (err) {
      app.log.error({ err }, "Erro checkout MP");
      return reply.code(502).send({ erro: "erro no checkout" });
    }
  });

  // Assinatura recorrente (preapproval) — cartão cobrado automaticamente todo mês.
  app.post("/api/assinar", { preHandler: [app.requireAuth] }, async (req, reply) => {
    if (!config.MP_ACCESS_TOKEN) return reply.code(503).send({ erro: "pagamento não configurado" });
    const p = z.object({ plano: z.enum(PLANOS_PAGAVEIS) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ erro: "plano inválido" });
    const { tenantId } = req.auth!;
    const info = PLANOS[p.data.plano];
    const dono = (await db.select({ email: usuarios.email }).from(usuarios).where(and(eq(usuarios.tenantId, tenantId), eq(usuarios.papel, "owner"))).limit(1))[0];
    const body = {
      reason: `Nexus RMM - Plano ${info.nome}`,
      external_reference: `${tenantId}:${p.data.plano}`,
      payer_email: dono?.email,
      back_url: `${config.APP_URL}/painel`,
      auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: info.precoMes, currency_id: "BRL" },
      status: "pending",
    };
    try {
      const r = await fetch("https://api.mercadopago.com/preapproval", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.MP_ACCESS_TOKEN}` },
        body: JSON.stringify(body),
      });
      const j = (await r.json()) as any;
      if (!r.ok || !j.init_point) { app.log.error({ status: r.status, j }, "MP preapproval falhou"); return reply.code(502).send({ erro: "falha ao criar assinatura" }); }
      return reply.send({ url: j.init_point });
    } catch (err) {
      app.log.error({ err }, "Erro assinatura MP");
      return reply.code(502).send({ erro: "erro na assinatura" });
    }
  });

  // Webhook do Mercado Pago — valida assinatura HMAC antes de processar.
  app.post("/api/mp/webhook", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    reply.send({ ok: true }); // MP espera 200 rápido
    try {
      if (!config.MP_ACCESS_TOKEN) return;

      // C3: Verificar assinatura HMAC do Mercado Pago (x-signature header).
      // Doc: https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks
      const sig     = req.headers["x-signature"] as string | undefined;
      const reqId   = req.headers["x-request-id"] as string | undefined;
      const query   = (req.query as any) || {};
      const dataId  = query["data.id"] || (req.body as any)?.data?.id;

      if (sig && reqId && dataId && config.MP_WEBHOOK_SECRET) {
        const parts = Object.fromEntries(
          sig.split(",").map((p: string) => p.trim().split("=") as [string, string])
        );
        const ts = parts["ts"] ?? "";
        const manifest = `id:${dataId};request-id:${reqId};ts:${ts};`;
        const expected = crypto
          .createHmac("sha256", config.MP_WEBHOOK_SECRET)
          .update(manifest)
          .digest("hex");
        if (expected !== parts["v1"]) {
          app.log.warn({ reqId }, "Webhook MP: assinatura inválida — descartado");
          return;
        }
      } else if (sig && config.MP_WEBHOOK_SECRET) {
        // Tem secret configurado mas faltam headers — rejeitar por precaução
        app.log.warn("Webhook MP: headers de assinatura incompletos");
        return;
      }
      // Se MP_WEBHOOK_SECRET não estiver configurado, aceitar sem validação
      // (retrocompatível com instalações sem a variável)

      const body = (req.body as any) || {};
      const tipo = body.type || body.topic || query.type || query.topic;
      const paymentId = body?.data?.id || body?.["data.id"] || query.id || query["data.id"];
      if (tipo !== "payment" || !paymentId) return;

      const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, { headers: { Authorization: `Bearer ${config.MP_ACCESS_TOKEN}` } });
      const pay = (await r.json()) as any;
      if (!r.ok || pay.status !== "approved") return;

      const [tenantId, plano] = String(pay.external_reference || "").split(":");
      if (!tenantId || !plano || !(PLANOS_PAGAVEIS as readonly string[]).includes(plano)) return;
      // Renovação acumula: +30 dias a partir de hoje OU do vencimento futuro atual.
      const atual = (await db.select({ pagoAte: tenants.pagoAte }).from(tenants).where(eq(tenants.id, tenantId)).limit(1))[0];
      const base = atual?.pagoAte && new Date(atual.pagoAte).getTime() > Date.now() ? new Date(atual.pagoAte).getTime() : Date.now();
      const pagoAte = new Date(base + 30 * 86400000);
      await db.update(tenants).set({ plano, trialExpiraEm: null, pagoAte }).where(eq(tenants.id, tenantId));
      limparCachePlano(tenantId);
      app.log.info({ tenantId, plano, paymentId, pagoAte }, "Pagamento aprovado - plano ativado/renovado");
      // E-mail de confirmação ao dono (best-effort).
      const dono = (await db.select({ email: usuarios.email }).from(usuarios).where(and(eq(usuarios.tenantId, tenantId), eq(usuarios.papel, "owner"))).limit(1))[0];
      if (dono?.email) void emailPagamentoConfirmado(dono.email, PLANOS[plano as "essencial" | "pro"].nome);
    } catch (err) {
      app.log.error({ err }, "Erro no webhook MP");
    }
  });
};
