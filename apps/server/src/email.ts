import nodemailer from "nodemailer";
import { eq } from "drizzle-orm";
import { comTenant } from "./db/tenant";
import { notificacoesConfig } from "./db/schema";

/** Envia um e-mail via SMTP do tenant. Best-effort — retorna true se enviou. */
export async function enviarEmail(tenantId: string, assunto: string, html: string, destinoOverride?: string): Promise<{ ok: boolean; erro?: string }> {
  try {
    const cfg = (
      await comTenant(tenantId, (tdb) =>
        tdb.select().from(notificacoesConfig).where(eq(notificacoesConfig.tenantId, tenantId)).limit(1),
      )
    )[0];
    if (!cfg || !cfg.emailAtivo || !cfg.smtpHost || !cfg.smtpUser) return { ok: false, erro: "SMTP não configurado/ativo" };
    const dest = (destinoOverride || cfg.emailDestinatarios || "").split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    if (dest.length === 0) return { ok: false, erro: "sem destinatários" };

    const porta = cfg.smtpPort || 587;
    const transporter = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: porta,
      secure: porta === 465, // 465=SSL direto; 587=STARTTLS
      auth: { user: cfg.smtpUser, pass: cfg.smtpPass || "" },
      connectionTimeout: 12000,
    });
    await transporter.sendMail({
      from: cfg.smtpFrom || cfg.smtpUser,
      to: dest.join(", "),
      subject: assunto,
      text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      html,
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, erro: e?.message || "falha ao enviar" };
  }
}
