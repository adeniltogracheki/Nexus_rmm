/**
 * webhooks.ts — Receptores de webhook para aprovação de remediação IA.
 *
 * POST /api/webhooks/telegram/:tenantId   — recebe updates do Telegram Bot
 * POST /api/webhooks/whatsapp/:tenantId   — recebe eventos da Evolution API (WhatsApp)
 *
 * Segurança:
 *   - tenantId no path (UUID, imprevisível)
 *   - Telegram: validamos X-Telegram-Bot-Api-Secret-Token
 *   - WhatsApp: Evolution API envia para URL registrada — chave no path
 *   - Ambos chamam processarRespostaAprovacao() que valida o código no DB
 */
import type { FastifyPluginAsync } from "fastify";
import { processarRespostaAprovacao } from "../monitoramento/aprovacaoRemediacao";
import { notificacoesConfig } from "../db/schema";
import { eq } from "drizzle-orm";
import { comTenant } from "../db/tenant";

// Regex para capturar intenção: "SIM ABC123", "NÃO ABC123", "NAO ABC123", "RECUSAR ABC123"
const RE_APROVADO  = /^(sim|s|yes|autorizar|ok)\s+([A-Z0-9]{6})/i;
const RE_RECUSADO  = /^(não|nao|n|no|recusar|cancelar|negar)\s+([A-Z0-9]{6})/i;
// Sem código — ignora (usuário pode ter digitado errado)

function parsearResposta(texto: string): { aprovado: boolean; codigo: string } | null {
  const t = texto.trim();
  const matchApr = RE_APROVADO.exec(t);
  if (matchApr) return { aprovado: true, codigo: matchApr[2]!.toUpperCase() };
  const matchRec = RE_RECUSADO.exec(t);
  if (matchRec) return { aprovado: false, codigo: matchRec[2]!.toUpperCase() };
  return null;
}

export const webhooksRoutes: FastifyPluginAsync = async (app) => {

  // ── Telegram ────────────────────────────────────────────────────────────────
  app.post("/api/webhooks/telegram/:tenantId", {
    config: { rawBody: true },
  }, async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };

    // Valida secret token (opcional mas recomendado — definido ao registrar o webhook)
    const secretHeader = req.headers["x-telegram-bot-api-secret-token"] as string | undefined;
    if (secretHeader) {
      // Verifica contra o secret salvo no banco (se configurado)
      const cfgs = await comTenant(tenantId, (tdb) =>
        tdb.select({ secret: notificacoesConfig.telegramWebhookSecret })
          .from(notificacoesConfig).where(eq(notificacoesConfig.tenantId, tenantId)).limit(1),
      ).catch(() => [] as Array<{ secret: string | null }>);
      const savedSecret = cfgs[0]?.secret;
      if (savedSecret && secretHeader !== savedSecret) {
        return reply.code(403).send({ erro: "Secret inválido" });
      }
    }

    const body = req.body as {
      message?: { text?: string; from?: { first_name?: string; username?: string } };
    };

    const texto = body?.message?.text ?? "";
    const from = body?.message?.from;
    const fromLabel = from?.username ? `@${from.username}` : (from?.first_name ?? "alguém");

    const resposta = parsearResposta(texto);
    if (!resposta) {
      return reply.send({ ok: true }); // ignora mensagens sem código
    }

    const resultado = await processarRespostaAprovacao(
      resposta.codigo,
      resposta.aprovado,
      `telegram:${fromLabel}`,
    );

    app.log.info({ tenantId, codigo: resposta.codigo, aprovado: resposta.aprovado, fromLabel, resultado }, "Webhook Telegram processado");

    // Resposta ao Telegram (confirma via sendMessage se conseguimos o botToken)
    if (resultado.ok || resultado.mensagem.includes("inválido") || resultado.mensagem.includes("expirado")) {
      const cfgs = await comTenant(tenantId, (tdb) =>
        tdb.select({ botToken: notificacoesConfig.telegramBotToken, chatId: notificacoesConfig.telegramChatIdBot })
          .from(notificacoesConfig).where(eq(notificacoesConfig.tenantId, tenantId)).limit(1),
      ).catch(() => [] as Array<{botToken:string|null; chatId:string|null}>);

      const cfg = cfgs[0];
      if (cfg?.botToken && cfg.chatId) {
        fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: cfg.chatId, text: resultado.mensagem }),
          signal: AbortSignal.timeout(6000),
        }).catch(() => {});
      }
    }

    return reply.send({ ok: true });
  });

  // ── WhatsApp (Evolution API) ────────────────────────────────────────────────
  app.post("/api/webhooks/whatsapp/:tenantId", async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    const body = req.body as {
      event?: string;
      data?: {
        key?: { fromMe?: boolean };
        message?: { conversation?: string; extendedTextMessage?: { text?: string } };
      };
    };

    // Ignora mensagens enviadas pelo próprio número (fromMe)
    if (body?.data?.key?.fromMe) return reply.send({ ok: true });

    // Suporta texto simples e texto estendido
    const texto = body?.data?.message?.conversation
      ?? body?.data?.message?.extendedTextMessage?.text
      ?? "";

    const resposta = parsearResposta(texto);
    if (!resposta) return reply.send({ ok: true });

    const resultado = await processarRespostaAprovacao(
      resposta.codigo,
      resposta.aprovado,
      "whatsapp:usuario",
    );

    app.log.info({ tenantId, codigo: resposta.codigo, aprovado: resposta.aprovado, resultado }, "Webhook WhatsApp processado");

    // Confirma pelo WhatsApp
    if (resultado.mensagem) {
      const cfgStr = await import("../redis").then((r) => r.redis.get(`wa-config:${tenantId}`)).catch(() => null);
      if (cfgStr) {
        const cfg = JSON.parse(cfgStr) as { ativo: boolean; apiUrl: string; instancia: string; apiKey: string; numero: string };
        if (cfg.ativo && cfg.apiUrl && cfg.instancia && cfg.numero) {
          fetch(`${cfg.apiUrl}/message/sendText/${cfg.instancia}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "apikey": cfg.apiKey },
            body: JSON.stringify({ number: cfg.numero, text: resultado.mensagem }),
            signal: AbortSignal.timeout(6000),
          }).catch(() => {});
        }
      }
    }

    return reply.send({ ok: true });
  });
};
