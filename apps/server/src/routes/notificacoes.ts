import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { comTenant } from "../db/tenant";
import { notificacoesConfig } from "../db/schema";
import { hostInternoBloqueado } from "../gateway/agent";
import { enviarEmail } from "../email";

const podeGerir = (papel?: string) => papel === "owner" || papel === "admin";

const ConfigBody = z.object({
  webhookUrl: z.string().max(1000).nullable().optional(),
  formato: z.enum(["generico", "slack", "telegram"]).optional(),
  telegramChatId: z.string().max(100).nullable().optional(),
  minSeveridade: z.enum(["info", "aviso", "critico"]).optional(),
  ativo: z.boolean().optional(),
  relatorioSemanal: z.boolean().optional(),
  emailAtivo: z.boolean().optional(),
  smtpHost: z.string().max(200).nullable().optional(),
  smtpPort: z.number().int().min(1).max(65535).nullable().optional(),
  smtpSeguro: z.boolean().optional(),
  smtpUser: z.string().max(200).nullable().optional(),
  smtpPass: z.string().max(400).nullable().optional(),
  smtpFrom: z.string().max(200).nullable().optional(),
  emailDestinatarios: z.string().max(1000).nullable().optional(),
});

async function enviarTeste(cfg: any): Promise<{ ok: boolean; status?: number; erro?: string }> {
  if (!cfg?.webhookUrl || !/^https?:\/\//i.test(cfg.webhookUrl)) {
    return { ok: false, erro: "Configure uma URL de webhook (http/https) primeiro." };
  }
  if (hostInternoBloqueado(cfg.webhookUrl)) {
    return { ok: false, erro: "URL de rede interna não é permitida (segurança)." };
  }
  const texto = "✅ Nexus RMM: teste de notificação. Se você recebeu isto, está tudo certo!";
  let body: string;
  if (cfg.formato === "telegram") body = JSON.stringify({ chat_id: cfg.telegramChatId, text: texto });
  else if (cfg.formato === "slack") body = JSON.stringify({ text: texto });
  else body = JSON.stringify({ origem: "nexus-rmm", texto, teste: true, em: Date.now() });
  try {
    const r = await fetch(cfg.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(8000),
    });
    return { ok: r.ok, status: r.status };
  } catch (e: any) {
    return { ok: false, erro: e?.message || "falha ao enviar" };
  }
}

export const notificacoesRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/notificacoes", { preHandler: [app.requireAuth] }, async (req, reply) => {
    if (!podeGerir(req.auth!.papel)) return reply.code(403).send({ erro: "sem permissão" });
    const { tenantId } = req.auth!;
    const cfg = (
      await comTenant(tenantId, (tdb) =>
        tdb.select().from(notificacoesConfig).where(eq(notificacoesConfig.tenantId, tenantId)).limit(1),
      )
    )[0];
    if (!cfg) {
      return reply.send({ tenantId, webhookUrl: null, formato: "generico", telegramChatId: null, minSeveridade: "aviso", ativo: false, relatorioSemanal: false, emailAtivo: false, smtpHost: null, smtpPort: null, smtpSeguro: true, smtpUser: null, smtpFrom: null, emailDestinatarios: null, smtpDefinida: false });
    }
    // Não devolve a senha SMTP em claro (segurança); só indica se está definida.
    const { smtpPass, ...resto } = cfg as any;
    return reply.send({ ...resto, smtpPass: "", smtpDefinida: !!smtpPass });
  });

  app.put("/api/notificacoes", { preHandler: [app.requireAuth, app.requireMfa] }, async (req, reply) => {
    if (!podeGerir(req.auth!.papel)) return reply.code(403).send({ erro: "sem permissão" });
    const { tenantId } = req.auth!;
    const p = ConfigBody.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ erro: "dados inválidos" });
    const vals = {
      tenantId,
      webhookUrl: p.data.webhookUrl ?? null,
      formato: p.data.formato ?? "generico",
      telegramChatId: p.data.telegramChatId ?? null,
      minSeveridade: p.data.minSeveridade ?? "aviso",
      ativo: p.data.ativo ?? false,
      relatorioSemanal: p.data.relatorioSemanal ?? false,
      emailAtivo: p.data.emailAtivo ?? false,
      smtpHost: p.data.smtpHost ?? null,
      smtpPort: p.data.smtpPort ?? null,
      smtpSeguro: p.data.smtpSeguro ?? true,
      smtpUser: p.data.smtpUser ?? null,
      smtpPass: p.data.smtpPass ?? null,
      smtpFrom: p.data.smtpFrom ?? null,
      emailDestinatarios: p.data.emailDestinatarios ?? null,
    };
    // Só atualiza a senha SMTP se foi informada (em branco = mantém a salva).
    const setObj: Record<string, unknown> = {
      webhookUrl: vals.webhookUrl, formato: vals.formato, telegramChatId: vals.telegramChatId,
      minSeveridade: vals.minSeveridade, ativo: vals.ativo, relatorioSemanal: vals.relatorioSemanal,
      emailAtivo: vals.emailAtivo, smtpHost: vals.smtpHost, smtpPort: vals.smtpPort, smtpSeguro: vals.smtpSeguro,
      smtpUser: vals.smtpUser, smtpFrom: vals.smtpFrom, emailDestinatarios: vals.emailDestinatarios,
    };
    if (p.data.smtpPass) setObj.smtpPass = p.data.smtpPass;
    try {
      await comTenant(tenantId, async (tdb) => {
        await tdb
          .insert(notificacoesConfig)
          .values({ ...vals, smtpPass: p.data.smtpPass || null })
          .onConflictDoUpdate({ target: notificacoesConfig.tenantId, set: setObj });
      });
      return reply.send({ ok: true });
    } catch (err) {
      app.log.error({ err, tenantId }, "Erro ao salvar config de notificações");
      return reply.code(500).send({ erro: "erro ao salvar" });
    }
  });

  app.post("/api/notificacoes/testar", { preHandler: [app.requireAuth] }, async (req, reply) => {
    if (!podeGerir(req.auth!.papel)) return reply.code(403).send({ erro: "sem permissão" });
    const { tenantId } = req.auth!;
    const cfg = (
      await comTenant(tenantId, (tdb) =>
        tdb.select().from(notificacoesConfig).where(eq(notificacoesConfig.tenantId, tenantId)).limit(1),
      )
    )[0];
    const res = await enviarTeste(cfg);
    return reply.send(res);
  });

  // Testa o envio por e-mail (SMTP).
  app.post("/api/notificacoes/testar-email", { preHandler: [app.requireAuth, app.requireMfa] }, async (req, reply) => {
    if (!podeGerir(req.auth!.papel)) return reply.code(403).send({ erro: "sem permissão" });
    const r = await enviarEmail(
      req.auth!.tenantId,
      "✅ Teste — Nexus RMM",
      `<div style="font-family:system-ui;padding:16px"><h2 style="color:#10b981">Nexus RMM</h2><p>Este é um <b>e-mail de teste</b>. Se você recebeu, o SMTP está configurado corretamente! 🎉</p></div>`,
    );
    if (r.ok) return reply.send({ ok: true });
    return reply.code(400).send({ ok: false, erro: r.erro || "falha ao enviar e-mail" });
  });
};
