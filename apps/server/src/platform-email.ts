import { eq } from "drizzle-orm";
import { db } from "./db";
import { tenants } from "./db/schema";
import { config } from "./config";
import { enviarEmail } from "./email";

let platformTenantId: string | null | undefined;

async function tenantPlataforma(): Promise<string | null> {
  if (platformTenantId !== undefined) return platformTenantId;
  const t = (await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, config.SEED_TENANT_SLUG)).limit(1))[0];
  platformTenantId = t?.id ?? null;
  return platformTenantId;
}

const MARCA = "#10b981";
function molde(titulo: string, corpo: string, cta?: { texto: string; url: string }): string {
  return `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:auto;color:#1a1a1a">
    <h2 style="color:${MARCA}">Nexus RMM</h2>
    <h3>${titulo}</h3>
    <div style="font-size:15px;line-height:1.6;color:#333">${corpo}</div>
    ${cta ? `<p style="margin-top:20px"><a href="${cta.url}" style="background:${MARCA};color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">${cta.texto}</a></p>` : ""}
    <p style="color:#999;font-size:12px;margin-top:24px">Nexus RMM · controle total da sua frota de TI</p>
  </div>`;
}

/** Envia um e-mail da PLATAFORMA (SMTP do tenant raiz) para um destinatário avulso. Best-effort. */
async function enviarPlataforma(destino: string, assunto: string, html: string): Promise<void> {
  try {
    const tid = await tenantPlataforma();
    if (!tid) return;
    await enviarEmail(tid, assunto, html, destino);
  } catch {
    // best-effort
  }
}

const URL = config.APP_URL;

export function emailBoasVindas(destino: string, empresa: string): Promise<void> {
  return enviarPlataforma(destino, "Bem-vindo ao Nexus RMM 🎉", molde(
    `Sua conta da ${empresa} está pronta!`,
    `Você tem <b>7 dias de teste grátis</b>. Instale o agente em 1 máquina e veja a mágica: tela ao vivo + terminal, direto do navegador.`,
    { texto: "Acessar o painel", url: `${URL}/login` },
  ));
}

export function emailTrialAcabando(destino: string, dias: number): Promise<void> {
  return enviarPlataforma(destino, `Seu teste acaba em ${dias} dia(s) ⏳`, molde(
    `Faltam ${dias} dia(s) do seu teste`,
    `Não perca o acesso às suas máquinas. Assine um plano e continue com tudo funcionando — seus dados ficam salvos.`,
    { texto: "Ver planos e assinar", url: `${URL}/painel` },
  ));
}

export function emailPagamentoConfirmado(destino: string, plano: string): Promise<void> {
  return enviarPlataforma(destino, "Pagamento confirmado ✅", molde(
    `Seu plano ${plano} está ativo!`,
    `Recebemos seu pagamento e liberamos tudo. Obrigado por assinar o Nexus RMM. 🚀`,
    { texto: "Ir para o painel", url: `${URL}/painel` },
  ));
}

export function emailAssinaturaVencendo(destino: string, dias: number): Promise<void> {
  return enviarPlataforma(destino, `Sua assinatura vence em ${dias} dia(s) 🔄`, molde(
    `Renove para não perder o acesso`,
    `Sua assinatura do Nexus RMM vence em ${dias} dia(s). Renove para manter tudo funcionando sem interrupção.`,
    { texto: "Renovar agora", url: `${URL}/painel` },
  ));
}
