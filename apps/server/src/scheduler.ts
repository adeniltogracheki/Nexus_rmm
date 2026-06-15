import crypto from "node:crypto";
import { and, eq, lte, gte, isNull, isNotNull } from "drizzle-orm";
import { db } from "./db/index";
import { tarefasAgendadas, notificacoesConfig, maquinas, logsServicosWindows, manutencoes, tenants, usuarios } from "./db/schema";
import { acessoInfo } from "./plano-guard";
import { emailTrialAcabando, emailAssinaturaVencendo } from "./platform-email";
import { obterOuCriarCa } from "./pki/ca";
import { obterPayloadAssinatura } from "@nexus/protocol";
import { enviarComandoAgente, enviarTextoWebhook, criarAlerta } from "./gateway/agent";
import { comTenant } from "./db/tenant";
import { enviarEmail } from "./email";

/** Cria alerta (no sino + webhook) para preventivas vencidas ainda não avisadas. */
async function verificarPreventivasVencidas(agora: Date): Promise<void> {
  try {
    const due = await db
      .select({ id: manutencoes.id, tenantId: manutencoes.tenantId, maquinaId: manutencoes.maquinaId, hostname: maquinas.hostname, apelido: maquinas.apelido })
      .from(manutencoes)
      .leftJoin(maquinas, eq(manutencoes.maquinaId, maquinas.id))
      .where(and(isNotNull(manutencoes.proximaPreventiva), lte(manutencoes.proximaPreventiva, agora), isNull(manutencoes.alertadoEm)));
    for (const d of due) {
      const nome = d.apelido || d.hostname || "máquina";
      try {
        await criarAlerta(d.tenantId, d.maquinaId, "preventiva", "aviso", `🔧 Manutenção preventiva vencida: "${nome}" precisa de revisão.`);
        await db.update(manutencoes).set({ alertadoEm: agora }).where(eq(manutencoes.id, d.id));
      } catch {
        // best-effort por registro
      }
    }
  } catch {
    // best-effort
  }
}

const SEMANA_MS = 7 * 86400000;

/** Lembretes de cobrança: trial acabando / assinatura vencendo (1-2 dias), dedup ~20h. */
async function verificarAvisosCobranca(agora: Date): Promise<void> {
  try {
    const ts = await db.select({ id: tenants.id, plano: tenants.plano, avisoVencimentoEm: tenants.avisoVencimentoEm }).from(tenants);
    for (const t of ts) {
      if (t.plano === "enterprise") continue;
      const ultimo = t.avisoVencimentoEm ? new Date(t.avisoVencimentoEm).getTime() : 0;
      if (agora.getTime() - ultimo < 20 * 3600000) continue;
      const a = await acessoInfo(t.id);
      if (a.bloqueado || !a.motivo || a.diasRestantes < 1 || a.diasRestantes > 2) continue;
      const dono = (await db.select({ email: usuarios.email }).from(usuarios).where(and(eq(usuarios.tenantId, t.id), eq(usuarios.papel, "owner"))).limit(1))[0];
      if (!dono?.email) continue;
      if (a.motivo === "trial") await emailTrialAcabando(dono.email, a.diasRestantes);
      else await emailAssinaturaVencendo(dono.email, a.diasRestantes);
      await db.update(tenants).set({ avisoVencimentoEm: agora }).where(eq(tenants.id, t.id));
    }
  } catch {
    // best-effort
  }
}

/** Envia o relatório semanal aos tenants que ativaram (via webhook). Best-effort. */
async function verificarRelatorioSemanal(agora: Date): Promise<void> {
  try {
    const configs = await db
      .select()
      .from(notificacoesConfig)
      .where(and(eq(notificacoesConfig.relatorioSemanal, true), eq(notificacoesConfig.ativo, true)));
    for (const c of configs) {
      const ultimo = c.relatorioUltimoEnvio ? new Date(c.relatorioUltimoEnvio).getTime() : 0;
      if (agora.getTime() - ultimo < SEMANA_MS) continue;
      try {
        const resumo = await comTenant(c.tenantId, async (tdb) => {
          const mq = await tdb.select().from(maquinas).where(eq(maquinas.arquivada, false));
          const total = mq.length;
          const online = mq.filter((m) => m.online).length;
          const desde = new Date(agora.getTime() - SEMANA_MS);
          const logs = await tdb.select({ id: logsServicosWindows.id }).from(logsServicosWindows).where(gte(logsServicosWindows.executadoEm, desde));
          return { total, online, offline: total - online, acoes: logs.length };
        });
        const texto =
          `📊 Relatório Semanal — Nexus RMM\n` +
          `🖥️ Máquinas: ${resumo.total} (🟢 ${resumo.online} online · ⚫ ${resumo.offline} offline)\n` +
          `⚡ Ações na semana: ${resumo.acoes}\n` +
          `📅 ${agora.toLocaleDateString("pt-BR")}`;
        const ok = await enviarTextoWebhook(c.tenantId, texto);
        const html = `<div style="font-family:system-ui;max-width:560px;margin:auto">
          <h2 style="color:#10b981">📊 Relatório Semanal — Nexus RMM</h2>
          <table style="font-size:15px;line-height:1.8">
            <tr><td>🖥️ Máquinas:</td><td><b>${resumo.total}</b> (🟢 ${resumo.online} online · ⚫ ${resumo.offline} offline)</td></tr>
            <tr><td>⚡ Ações na semana:</td><td><b>${resumo.acoes}</b></td></tr>
          </table>
          <p style="color:#888;font-size:12px">Gerado em ${agora.toLocaleString("pt-BR")}</p>
        </div>`;
        const okMail = await enviarEmail(c.tenantId, "📊 Relatório Semanal — Nexus RMM", html);
        if (ok || okMail.ok) await db.update(notificacoesConfig).set({ relatorioUltimoEnvio: agora }).where(eq(notificacoesConfig.tenantId, c.tenantId));
      } catch {
        // best-effort por tenant
      }
    }
  } catch {
    // best-effort
  }
}

/** Próximo horário "HH:MM" depois de `base` (hoje se ainda no futuro, senão amanhã). */
function proximoHorarioDiario(horario: string | null, base: Date): Date {
  const [h, m] = (horario || "03:00").split(":").map((x) => Number(x));
  const d = new Date(base);
  d.setHours(h || 0, m || 0, 0, 0);
  if (d <= base) d.setDate(d.getDate() + 1);
  return d;
}

async function dispararShell(
  machineId: string,
  comando: string,
  shell: string,
): Promise<"SUCESSO" | "FALHA"> {
  try {
    const { caKeyPem } = obterOuCriarCa();
    const commandId = crypto.randomUUID();
    const issuedAt = Date.now();
    const payload = {
      commandId,
      machineId,
      issuedAt,
      expiresAt: issuedAt + 120_000,
      type: "shell.run" as const,
      shell: (shell === "cmd" ? "cmd" : "powershell") as "cmd" | "powershell",
      command: comando,
    };
    const canonical = obterPayloadAssinatura(payload as never);
    const sign = crypto.createSign("SHA256");
    sign.update(canonical);
    const signature = sign.sign(caKeyPem, "hex");
    const r = await enviarComandoAgente(machineId, { ...payload, signature } as never);
    return r.status === "FALHA" ? "FALHA" : "SUCESSO";
  } catch {
    return "FALHA";
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function iniciarAgendador(): void {
  if (timer) return;
  const tick = async (): Promise<void> => {
    try {
      const agora = new Date();
      const due = await db
        .select()
        .from(tarefasAgendadas)
        .where(and(eq(tarefasAgendadas.ativo, true), lte(tarefasAgendadas.proximaExec, agora)));
      for (const t of due) {
        const status = await dispararShell(t.maquinaId, t.comando, t.shell);
        let proximaExec: Date | null = null;
        let ativo = true;
        if (t.frequencia === "diaria") {
          proximaExec = proximoHorarioDiario(t.horario, agora);
        } else {
          ativo = false; // "unica" roda uma vez
        }
        await db
          .update(tarefasAgendadas)
          .set({ ultimaExec: agora, ultimoStatus: status, proximaExec, ativo })
          .where(eq(tarefasAgendadas.id, t.id));
      }
      await verificarRelatorioSemanal(agora);
      await verificarPreventivasVencidas(agora);
      await verificarAvisosCobranca(agora);
    } catch {
      // agendador é best-effort; não derruba o processo
    }
  };
  timer = setInterval(tick, 60_000);
  timer.unref?.();
}

export function encerrarAgendador(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
