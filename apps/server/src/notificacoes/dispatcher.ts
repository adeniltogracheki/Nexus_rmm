/**
 * dispatcher.ts — Despacha alertas para todos os canais configurados pelo tenant.
 * Suporta: Email (SMTP), Telegram (Bot API), WhatsApp (Evolution API), Webhook genérico.
 * Todas as funções são best-effort: nunca lançam exceção para o chamador.
 */
import nodemailer from "nodemailer";
import { eq } from "drizzle-orm";
import { notificacoesConfig } from "../db/schema";
import { comTenant } from "../db/tenant";
import { redis } from "../redis";

const ORDEM_SEV: Record<string, number> = { info: 0, aviso: 1, critico: 2 };

export interface AlertaPayload {
  severidade: "info" | "aviso" | "critico";
  tipo: string;           // "cpu" | "ram" | "disco" | "offline" | "ia_remediacão"
  mensagem: string;
  maquinaNome?: string;
  criticidade?: string;   // criticidade da máquina
  detalhes?: string;      // texto adicional para o corpo do e-mail
}

// ─── Email ────────────────────────────────────────────────────────────────────

async function enviarEmail(
  cfg: {
    smtpHost: string | null; smtpPort: number | null; smtpSeguro: boolean;
    smtpUser: string | null; smtpPass: string | null; smtpFrom: string | null;
    emailDestinatarios: string | null;
  },
  alerta: AlertaPayload,
  htmlExtra = "",
): Promise<void> {
  if (!cfg.smtpHost || !cfg.smtpPort || !cfg.smtpFrom || !cfg.emailDestinatarios) return;

  const transporter = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpSeguro,
    auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass ?? "" } : undefined,
    connectionTimeout: 8000,
    greetingTimeout: 5000,
  });

  const icone = alerta.severidade === "critico" ? "🔴" : alerta.severidade === "aviso" ? "🟠" : "🔵";
  const assunto = `${icone} Nexus RMM — ${alerta.maquinaNome ?? "Alerta"}: ${alerta.mensagem.slice(0, 80)}`;

  const corBadge = alerta.severidade === "critico" ? "#ef4444"
    : alerta.severidade === "aviso" ? "#f59e0b" : "#3b82f6";

  const html = `
<!DOCTYPE html><html lang="pt-br"><head><meta charset="utf-8">
<style>
  body{font-family:system-ui,sans-serif;background:#0f1117;color:#e4e8f0;margin:0;padding:24px}
  .card{max-width:600px;margin:0 auto;background:#1a1f2e;border-radius:12px;border:1px solid #2a3350;overflow:hidden}
  .header{background:${corBadge};padding:20px 24px}
  .header h1{margin:0;font-size:18px;color:#fff}
  .body{padding:24px}
  .badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;background:${corBadge}22;color:${corBadge};border:1px solid ${corBadge}44}
  .field{margin:12px 0}
  .label{font-size:11px;color:#6b7595;text-transform:uppercase;letter-spacing:.05em}
  .value{font-size:14px;color:#e4e8f0;margin-top:2px}
  .extra{background:#111827;border-radius:8px;padding:16px;font-family:monospace;font-size:12px;color:#9ca3af;margin-top:16px;white-space:pre-wrap}
  .footer{padding:16px 24px;border-top:1px solid #2a3350;font-size:11px;color:#4b5568}
</style></head><body>
<div class="card">
  <div class="header"><h1>${icone} Nexus RMM — Alerta de Monitoramento</h1></div>
  <div class="body">
    <span class="badge">${alerta.severidade.toUpperCase()}</span>
    <div class="field"><div class="label">Máquina</div><div class="value">${alerta.maquinaNome ?? "—"}</div></div>
    <div class="field"><div class="label">Criticidade</div><div class="value">${alerta.criticidade ?? "operacional"}</div></div>
    <div class="field"><div class="label">Mensagem</div><div class="value">${alerta.mensagem}</div></div>
    ${htmlExtra ? `<div class="extra">${htmlExtra}</div>` : ""}
  </div>
  <div class="footer">Nexus RMM · ${new Date().toLocaleString("pt-BR", { timeZone: "America/Cuiaba" })}</div>
</div>
</body></html>`;

  const destinos = cfg.emailDestinatarios.split(",").map((e) => e.trim()).filter(Boolean);
  await transporter.sendMail({ from: cfg.smtpFrom, to: destinos, subject: assunto, html });
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function enviarTelegram(botToken: string, chatId: string, texto: string): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: "Markdown" }),
    signal: AbortSignal.timeout(8000),
  });
}

// ─── WhatsApp via Evolution API ───────────────────────────────────────────────

async function enviarWhatsApp(tenantId: string, texto: string): Promise<void> {
  const cfgStr = await redis.get(`wa-config:${tenantId}`);
  if (!cfgStr) return;
  const cfg = JSON.parse(cfgStr) as {
    ativo: boolean; apiUrl: string; instancia: string; apiKey: string; numero: string;
    alertaCritico: boolean; alertaOffline: boolean;
  };
  if (!cfg.ativo || !cfg.apiUrl || !cfg.instancia || !cfg.numero) return;
  await fetch(`${cfg.apiUrl}/message/sendText/${cfg.instancia}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": cfg.apiKey },
    body: JSON.stringify({ number: cfg.numero, text: texto }),
    signal: AbortSignal.timeout(8000),
  });
}

// ─── Dispatcher central ───────────────────────────────────────────────────────

export async function despacharAlerta(
  tenantId: string,
  alerta: AlertaPayload,
  htmlExtra = "",
): Promise<void> {
  try {
    const cfgs = await comTenant(tenantId, (tdb) =>
      tdb.select().from(notificacoesConfig).where(eq(notificacoesConfig.tenantId, tenantId)).limit(1),
    );
    const cfg = cfgs[0];
    if (!cfg) return;

    const sevOrd = ORDEM_SEV[alerta.severidade] ?? 0;

    // Verifica toggles por tipo
    const ehOffline  = alerta.tipo === "offline";
    const ehCritico  = alerta.severidade === "critico";
    const ehAviso    = alerta.severidade === "aviso";
    if (ehCritico  && !cfg.notifCritico)  return;
    if (ehAviso    && !cfg.notifAviso)    return;
    if (ehOffline  && !cfg.notifOffline)  return;

    const icone = ehCritico ? "🔴" : ehAviso ? "🟠" : "🔵";
    const textoBase = `${icone} *Nexus RMM*\n*${alerta.mensagem}*\nMáquina: ${alerta.maquinaNome ?? "?"}\nCriticidade: ${alerta.criticidade ?? "operacional"}\n_${new Date().toLocaleString("pt-BR")}_`;

    const promises: Promise<void>[] = [];

    // Email
    if (cfg.emailAtivo) {
      promises.push(
        enviarEmail(cfg, alerta, htmlExtra).catch(() => {}),
      );
    }

    // Telegram bot dedicado
    if (cfg.telegramAtivo && cfg.telegramBotToken && cfg.telegramChatIdBot) {
      promises.push(
        enviarTelegram(cfg.telegramBotToken, cfg.telegramChatIdBot, textoBase).catch(() => {}),
      );
    }

    // Webhook genérico / Telegram via webhook (legado)
    if (cfg.ativo && cfg.webhookUrl) {
      const minSev = ORDEM_SEV[cfg.minSeveridade ?? "aviso"] ?? 1;
      if (sevOrd >= minSev) {
        const body = cfg.formato === "telegram"
          ? JSON.stringify({ chat_id: cfg.telegramChatId, text: textoBase })
          : cfg.formato === "slack"
            ? JSON.stringify({ text: textoBase })
            : JSON.stringify({ severidade: alerta.severidade, mensagem: alerta.mensagem, em: Date.now() });
        promises.push(
          fetch(cfg.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(6000) })
            .then(() => {}).catch(() => {}),
        );
      }
    }

    // WhatsApp
    const waFilter = ehCritico
      ? (JSON.parse((await redis.get(`wa-config:${tenantId}`)) ?? "{}") as any)?.alertaCritico
      : ehOffline
        ? (JSON.parse((await redis.get(`wa-config:${tenantId}`)) ?? "{}") as any)?.alertaOffline
        : false;
    if (waFilter) {
      promises.push(enviarWhatsApp(tenantId, textoBase).catch(() => {}));
    }

    await Promise.allSettled(promises);
  } catch {
    // dispatcher é best-effort
  }
}

/** Envia relatório rico por e-mail (pós-remediação, relatórios semanais). */
export async function enviarEmailRico(tenantId: string, assunto: string, html: string): Promise<boolean> {
  try {
    const cfgs = await comTenant(tenantId, (tdb) =>
      tdb.select().from(notificacoesConfig).where(eq(notificacoesConfig.tenantId, tenantId)).limit(1),
    );
    const cfg = cfgs[0];
    if (!cfg?.emailAtivo || !cfg.smtpHost || !cfg.smtpFrom || !cfg.emailDestinatarios) return false;

    const transporter = nodemailer.createTransport({
      host: cfg.smtpHost, port: cfg.smtpPort ?? 587, secure: cfg.smtpSeguro,
      auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass ?? "" } : undefined,
      connectionTimeout: 8000,
    });
    const destinos = cfg.emailDestinatarios.split(",").map((e) => e.trim()).filter(Boolean);
    await transporter.sendMail({ from: cfg.smtpFrom, to: destinos, subject: assunto, html });
    return true;
  } catch {
    return false;
  }
}
