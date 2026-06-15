/**
 * aprovacaoRemediacao.ts — Fluxo de aprovação humana antes de remediação IA.
 *
 * Fluxo:
 *   1. Engine detecta violação sustentada e chama criarAprovacaoPendente()
 *   2. IA (Haiku) propõe até 3 ações do catálogo
 *   3. Mensagem de aprovação enviada via Telegram + WhatsApp + e-mail
 *   4. Usuário responde "SIM <CODE>" ou "NÃO <CODE>" (ou clica no painel web)
 *   5. processarRespostaAprovacao() executa ou cancela
 *   6. Relatório enviado após execução
 *
 * Expiração: 10 minutos — após isso, a proposta é marcada como "expirado".
 */
import Anthropic from "@anthropic-ai/sdk";
import { eq, and, lt, sql } from "drizzle-orm";
import crypto from "node:crypto";
import { comTenant } from "../db/tenant";
import { remediacoesAprovacao, notificacoesConfig, maquinas } from "../db/schema";
import { redis } from "../redis";
import { despacharAlerta, enviarEmailRico } from "../notificacoes/dispatcher";
import { executarRemediacao } from "./remediacaoIa";
import { CATALOGO_SEGURO } from "./remediacaoIa";
import type { MetricaSnapshot } from "./engine";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXPIRACAO_MS = 10 * 60 * 1000; // 10 minutos

// ─── Gera código único de 6 chars (alfanumérico maiúsculo) ───────────────────

function gerarCodigo(): string {
  return crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
}

// ─── Consulta IA para propor ações ──────────────────────────────────────────

async function proporAcoes(
  nomeMaq: string,
  criticidade: string,
  triggerDescricao: string,
  acoesPermitidas: string[],
  snapshot: MetricaSnapshot,
): Promise<string[]> {
  try {
    const catalogo = acoesPermitidas
      .filter((id) => id in CATALOGO_SEGURO)
      .map((id) => `${id}: ${CATALOGO_SEGURO[id]!.desc}`)
      .join("\n");

    if (!catalogo) return [];

    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: `Máquina: ${nomeMaq} (criticidade: ${criticidade})
Situação: ${triggerDescricao}
CPU: ${snapshot.cpu}% | RAM: ${snapshot.ram}%

Ações disponíveis (escolha no máximo 3 que mais ajudam):
${catalogo}

Responda APENAS com JSON: {"acoes": ["id1", "id2"]}`,
      }],
    });

    const text = msg.content[0]?.type === "text" ? msg.content[0].text : "";
    const match = text.match(/\{[^}]+\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as { acoes?: string[] };
    return (parsed.acoes ?? []).filter((id) => id in CATALOGO_SEGURO && acoesPermitidas.includes(id)).slice(0, 3);
  } catch {
    // Fallback: retorna as primeiras ações permitidas
    return acoesPermitidas.filter((id) => id in CATALOGO_SEGURO).slice(0, 2);
  }
}

// ─── Envia mensagem de aprovação via Telegram Bot API ───────────────────────

async function enviarTelegramAprovacao(
  botToken: string,
  chatId: string,
  texto: string,
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: "Markdown" }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}

// ─── Envia mensagem de aprovação via WhatsApp (Evolution API) ───────────────

async function enviarWhatsAppAprovacao(tenantId: string, texto: string): Promise<void> {
  const cfgStr = await redis.get(`wa-config:${tenantId}`);
  if (!cfgStr) return;
  const cfg = JSON.parse(cfgStr) as {
    ativo: boolean; apiUrl: string; instancia: string; apiKey: string; numero: string;
  };
  if (!cfg.ativo || !cfg.apiUrl || !cfg.instancia || !cfg.numero) return;
  await fetch(`${cfg.apiUrl}/message/sendText/${cfg.instancia}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": cfg.apiKey },
    body: JSON.stringify({ number: cfg.numero, text: texto }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}

// ─── Cria registro de aprovação pendente e notifica canais ──────────────────

export async function criarAprovacaoPendente(
  tenantId: string,
  machineId: string,
  nomeMaq: string,
  criticidade: string,
  triggerDescricao: string,
  snapshot: MetricaSnapshot,
  triggers: string[],
): Promise<void> {
  try {
    // Cooldown: apenas 1 aprovação pendente por máquina por vez (30min)
    const keyBlock = `aprov:cooldown:${machineId}`;
    const bloqueado = await redis.set(keyBlock, "1", "EX", 1800, "NX");
    if (!bloqueado) return; // já tem uma aprovação pendente/recente

    // Busca config da máquina (ações permitidas)
    const maqRows = await comTenant(tenantId, (tdb) =>
      tdb.select({ iaAcoesPermitidas: maquinas.iaAcoesPermitidas })
        .from(maquinas).where(eq(maquinas.id, machineId)).limit(1),
    );
    const acoesPermitidas = (maqRows[0]?.iaAcoesPermitidas || []) as string[];

    // Filtra ações relevantes para os triggers atuais
    const acoesRelevantes = acoesPermitidas.filter((id) => {
      const a = CATALOGO_SEGURO[id];
      return a && triggers.some((t) => a.triggers.includes(t));
    });

    if (acoesRelevantes.length === 0) return;

    // IA propõe ações
    const acoesProposas = await proporAcoes(nomeMaq, criticidade, triggerDescricao, acoesRelevantes, snapshot);
    if (acoesProposas.length === 0) return;

    // Gera código único
    let codigo = gerarCodigo();
    let tentativas = 0;
    while (tentativas < 5) {
      const existe = await redis.get(`aprov:codigo:${codigo}`);
      if (!existe) break;
      codigo = gerarCodigo();
      tentativas++;
    }
    await redis.set(`aprov:codigo:${codigo}`, tenantId, "EX", 700); // 11min (TTL ligeiramente maior que expiração)

    const expiresAt = new Date(Date.now() + EXPIRACAO_MS);

    // Insere no banco
    await comTenant(tenantId, (tdb) =>
      tdb.insert(remediacoesAprovacao).values({
        tenantId,
        maquinaId: machineId,
        codigo,
        triggerDescricao,
        acoesProposas,
        metricasAntes: snapshot as any,
        status: "aguardando",
        expiresAt,
      }),
    );

    // Monta mensagem de aprovação
    const acoesTexto = acoesProposas.map((id) => `• ${CATALOGO_SEGURO[id]?.desc || id}`).join("\n");
    const mensagem = [
      `⚠️ *Nexus RMM — Aprovação Necessária*`,
      ``,
      `🖥️ *Máquina:* ${nomeMaq}`,
      `📋 *Problema:* ${triggerDescricao}`,
      ``,
      `🤖 *A IA propõe as seguintes ações:*`,
      acoesTexto,
      ``,
      `✅ Para *AUTORIZAR*: responda \`SIM ${codigo}\``,
      `❌ Para *RECUSAR*: responda \`NÃO ${codigo}\``,
      ``,
      `⏰ _Expira em 10 minutos_`,
    ].join("\n");

    // Busca config de notificações
    const cfgRows = await comTenant(tenantId, (tdb) =>
      tdb.select({
        telegramAtivo: notificacoesConfig.telegramAtivo,
        telegramBotToken: notificacoesConfig.telegramBotToken,
        telegramChatIdBot: notificacoesConfig.telegramChatIdBot,
        emailAtivo: notificacoesConfig.emailAtivo,
        smtpHost: notificacoesConfig.smtpHost,
        smtpPort: notificacoesConfig.smtpPort,
        smtpSeguro: notificacoesConfig.smtpSeguro,
        smtpUser: notificacoesConfig.smtpUser,
        smtpPass: notificacoesConfig.smtpPass,
        smtpFrom: notificacoesConfig.smtpFrom,
        emailDestinatarios: notificacoesConfig.emailDestinatarios,
      }).from(notificacoesConfig).where(eq(notificacoesConfig.tenantId, tenantId)).limit(1),
    );
    const cfg = cfgRows[0];

    // Envia via Telegram Bot API
    if (cfg?.telegramAtivo && cfg.telegramBotToken && cfg.telegramChatIdBot) {
      await enviarTelegramAprovacao(cfg.telegramBotToken, cfg.telegramChatIdBot, mensagem);
    }

    // Envia via WhatsApp
    await enviarWhatsAppAprovacao(tenantId, mensagem.replace(/\*/g, "*").replace(/`/g, ""));

    // Envia via e-mail (HTML)
    if (cfg?.emailAtivo) {
      const html = `
<div style="font-family:system-ui;background:#0f1117;color:#e4e8f0;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#1a1f2e;border-radius:12px;border:1px solid #f59e0b44;overflow:hidden">
    <div style="background:#f59e0b;padding:16px 24px"><h2 style="margin:0;color:#fff;font-size:16px">⚠️ Aprovação de Remediação IA — Nexus RMM</h2></div>
    <div style="padding:24px;space-y:16px">
      <p style="color:#9ca3af;font-size:13px">Máquina: <strong style="color:#e4e8f0">${nomeMaq}</strong></p>
      <p style="color:#9ca3af;font-size:13px">Problema detectado: <strong style="color:#e4e8f0">${triggerDescricao}</strong></p>
      <div style="background:#111827;border-radius:8px;padding:16px;margin:16px 0">
        <p style="color:#9ca3af;font-size:12px;margin:0 0 8px">Ações propostas pela IA:</p>
        <ul style="margin:0;padding-left:16px;color:#e4e8f0;font-size:13px">
          ${acoesProposas.map((id) => `<li>${CATALOGO_SEGURO[id]?.desc || id}</li>`).join("")}
        </ul>
      </div>
      <p style="color:#9ca3af;font-size:12px">Responda no Telegram/WhatsApp:</p>
      <p style="font-family:monospace;background:#0f1117;padding:8px 12px;border-radius:6px;font-size:14px;color:#00FFA7">SIM ${codigo}</p>
      <p style="color:#6b7595;font-size:11px">ou acesse o painel web → Segurança → Aprovações pendentes</p>
      <p style="color:#f59e0b;font-size:11px">⏰ Expira em 10 minutos. Código: ${codigo}</p>
    </div>
  </div>
</div>`;
      await enviarEmailRico(tenantId, `⚠️ Aprovação necessária — ${nomeMaq}`, html);
    }
  } catch {
    // aprovação é best-effort — nunca derruba o engine
  }
}

// ─── Processa resposta de aprovação (Telegram / WhatsApp) ───────────────────

export async function processarRespostaAprovacao(
  codigo: string,
  aprovado: boolean,
  aprovadoPor: string,
): Promise<{ ok: boolean; mensagem: string }> {
  try {
    // Valida código no Redis (cache rápido)
    const tenantId = await redis.get(`aprov:codigo:${codigo}`);
    if (!tenantId) return { ok: false, mensagem: "Código inválido ou expirado." };

    // Busca no banco
    const rows = await comTenant(tenantId, (tdb) =>
      tdb.select().from(remediacoesAprovacao)
        .where(and(
          eq(remediacoesAprovacao.codigo, codigo),
          eq(remediacoesAprovacao.status, "aguardando"),
        )).limit(1),
    );

    const pend = rows[0];
    if (!pend) return { ok: false, mensagem: "Aprovação não encontrada ou já processada." };

    // Verifica expiração
    if (new Date() > new Date(pend.expiresAt)) {
      await comTenant(tenantId, (tdb) =>
        tdb.update(remediacoesAprovacao)
          .set({ status: "expirado" })
          .where(eq(remediacoesAprovacao.id, pend.id)),
      );
      await redis.del(`aprov:codigo:${codigo}`);
      return { ok: false, mensagem: "A aprovação expirou. Uma nova análise será feita se o problema persistir." };
    }

    if (!aprovado) {
      // Recusado pelo usuário
      await comTenant(tenantId, (tdb) =>
        tdb.update(remediacoesAprovacao)
          .set({ status: "recusado", aprovadoPor })
          .where(eq(remediacoesAprovacao.id, pend.id)),
      );
      await redis.del(`aprov:codigo:${codigo}`);
      // Avisa que foi cancelado
      void despacharAlerta(tenantId, {
        severidade: "info",
        tipo: "ia_remediacão",
        mensagem: `Remediação IA cancelada por ${aprovadoPor} em "${await nomeMaquinaCache(tenantId, pend.maquinaId)}".`,
      });
      return { ok: true, mensagem: "Remediação cancelada com sucesso." };
    }

    // Aprovado — marca como aprovado antes de executar
    await comTenant(tenantId, (tdb) =>
      tdb.update(remediacoesAprovacao)
        .set({ status: "aprovado", aprovadoPor })
        .where(eq(remediacoesAprovacao.id, pend.id)),
    );
    await redis.del(`aprov:codigo:${codigo}`);

    // Executa em background
    const acoesProposas = (pend.acoesProposas || []) as string[];
    const snapshot = (pend.metricasAntes || { cpu: 0, ram: 0 }) as MetricaSnapshot;

    void (async () => {
      try {
        const nomeMaq = await nomeMaquinaCache(tenantId, pend.maquinaId);
        const rows2 = await comTenant(tenantId, (tdb) =>
          tdb.select({ criticidade: maquinas.criticidade }).from(maquinas).where(eq(maquinas.id, pend.maquinaId)).limit(1),
        );
        const criticidade = rows2[0]?.criticidade ?? "operacional";
        await executarRemediacao(
          tenantId, pend.maquinaId, nomeMaq, criticidade,
          `[Aprovado por ${aprovadoPor}] ${pend.triggerDescricao}`,
          snapshot,
          acoesProposas,
        );
      } catch {}
    })();

    return { ok: true, mensagem: `✅ Aprovado! A IA começará a remediação em instantes.` };
  } catch {
    return { ok: false, mensagem: "Erro interno ao processar aprovação." };
  }
}

// ─── Cache de nome da máquina ────────────────────────────────────────────────

async function nomeMaquinaCache(tenantId: string, machineId: string): Promise<string> {
  try {
    const cached = await redis.get(`maquina:${machineId}:nome`);
    if (cached) return cached;
    const rows = await comTenant(tenantId, (tdb) =>
      tdb.select({ apelido: maquinas.apelido, hostname: maquinas.hostname })
        .from(maquinas).where(eq(maquinas.id, machineId)).limit(1),
    );
    const nome = rows[0]?.apelido || rows[0]?.hostname || machineId;
    void redis.set(`maquina:${machineId}:nome`, nome, "EX", 300);
    return nome;
  } catch {
    return machineId;
  }
}

// ─── Marca aprovações expiradas (chamado periodicamente pelo cron) ───────────

export async function expirarAprovacoes(): Promise<void> {
  // Esta função deve ser chamada por um cron ou scheduler
  // Por ora, a expiração é verificada on-demand no processarRespostaAprovacao
}

// ─── Lista aprovações pendentes de um tenant ────────────────────────────────

export async function listarAprovacoesPendentes(tenantId: string) {
  const rows = await comTenant(tenantId, (tdb) =>
    tdb.select({
      id: remediacoesAprovacao.id,
      maquinaId: remediacoesAprovacao.maquinaId,
      codigo: remediacoesAprovacao.codigo,
      triggerDescricao: remediacoesAprovacao.triggerDescricao,
      acoesProposas: remediacoesAprovacao.acoesProposas,
      metricasAntes: remediacoesAprovacao.metricasAntes,
      status: remediacoesAprovacao.status,
      aprovadoPor: remediacoesAprovacao.aprovadoPor,
      expiresAt: remediacoesAprovacao.expiresAt,
      criadoEm: remediacoesAprovacao.criadoEm,
      maquinaNome: maquinas.apelido,
      maquinaHostname: maquinas.hostname,
    })
      .from(remediacoesAprovacao)
      .leftJoin(maquinas, eq(remediacoesAprovacao.maquinaId, maquinas.id))
      .where(and(
        eq(remediacoesAprovacao.tenantId, tenantId),
        eq(remediacoesAprovacao.status, "aguardando"),
        sql`${remediacoesAprovacao.expiresAt} > now()`,
      ))
      .orderBy(remediacoesAprovacao.criadoEm),
  );
  return rows;
}
