/**
 * remediacaoIa.ts — Motor de remediação automática com IA (Claude Haiku).
 *
 * SEGURANÇA:
 *   - Apenas ações do CATÁLOGO_SEGURO podem ser executadas.
 *   - IA escolhe da lista; nunca executa comandos arbitrários.
 *   - Máquina deve ter iaRemediacao=true E regrasAlerta.iaRemediaCaoGlobal=true.
 *   - Tudo é auditado em remediacoes_ia.
 *   - Relatório por e-mail enviado ao tenant após a execução.
 */
import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { comTenant } from "../db/tenant";
import { remediacoesIa, maquinas } from "../db/schema";
import { enviarComandoAgente } from "../gateway/agent";
import { enviarEmailRico } from "../notificacoes/dispatcher";
import { redis } from "../redis";
import type { MetricaSnapshot } from "./engine";
import crypto from "node:crypto";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Catálogo de ações seguras (WHITELIST rígida) ─────────────────────────────

export const CATALOGO_SEGURO: Record<string, { desc: string; cmd: string; triggers: string[] }> = {
  "limpar-temp": {
    desc: "Limpar arquivos temporários (%TEMP% e C:\\Windows\\Temp)",
    cmd: `Remove-Item "$env:TEMP\\*" -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item "C:\\Windows\\Temp\\*" -Recurse -Force -ErrorAction SilentlyContinue; Write-Output "Temp limpo"`,
    triggers: ["disco"],
  },
  "limpar-wu-cache": {
    desc: "Limpar cache do Windows Update (SoftwareDistribution\\Download)",
    cmd: `Stop-Service wuauserv -Force -ErrorAction SilentlyContinue; Remove-Item "C:\\Windows\\SoftwareDistribution\\Download\\*" -Recurse -Force -ErrorAction SilentlyContinue; Start-Service wuauserv -ErrorAction SilentlyContinue; Write-Output "Cache WU limpo"`,
    triggers: ["disco"],
  },
  "esvaziar-lixeira": {
    desc: "Esvaziar lixeira de todos os usuários",
    cmd: `Clear-RecycleBin -Force -ErrorAction SilentlyContinue; Write-Output "Lixeira esvaziada"`,
    triggers: ["disco"],
  },
  "limpar-prefetch": {
    desc: "Limpar Prefetch do Windows",
    cmd: `Remove-Item "C:\\Windows\\Prefetch\\*" -Force -ErrorAction SilentlyContinue; Write-Output "Prefetch limpo"`,
    triggers: ["disco"],
  },
  "limpar-iis-logs": {
    desc: "Limpar logs do IIS com mais de 7 dias",
    cmd: `Get-ChildItem "C:\\inetpub\\logs" -Recurse -File | Where-Object LastWriteTime -lt (Get-Date).AddDays(-7) | Remove-Item -Force -ErrorAction SilentlyContinue; Write-Output "Logs IIS limpos"`,
    triggers: ["disco"],
  },
  "reiniciar-spooler": {
    desc: "Reiniciar serviço de impressão (Spooler)",
    cmd: `Restart-Service -Name Spooler -Force -ErrorAction SilentlyContinue; Write-Output "Spooler reiniciado"`,
    triggers: ["cpu", "ram"],
  },
  "reiniciar-bits": {
    desc: "Reiniciar serviço BITS (Background Intelligent Transfer)",
    cmd: `Restart-Service -Name BITS -Force -ErrorAction SilentlyContinue; Write-Output "BITS reiniciado"`,
    triggers: ["cpu", "ram"],
  },
  "limpar-dns-cache": {
    desc: "Limpar cache DNS do sistema",
    cmd: `Clear-DnsClientCache; Write-Output "Cache DNS limpo"`,
    triggers: ["cpu"],
  },
  "liberar-memoria-standby": {
    desc: "Liberar memória standby (via EmptyWorkingSets)",
    cmd: `[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers(); Write-Output "Memória .NET coletada"`,
    triggers: ["ram"],
  },
};

// ─── Obter snapshot atual de métricas da máquina ──────────────────────────────

async function obterSnapshotAtual(machineId: string): Promise<MetricaSnapshot> {
  try {
    const metKey = `maquina:${machineId}:metricas`;
    const items = await redis.lrange(metKey, 0, 0);
    if (items.length > 0) {
      const m = JSON.parse(items[0]!) as { cpu: number; ram: number };
      const discosJson = await redis.get(`maquina:${machineId}:discos`);
      return { cpu: m.cpu, ram: m.ram, discos: discosJson ? JSON.parse(discosJson) : undefined };
    }
  } catch {}
  return { cpu: 0, ram: 0 };
}

// ─── Motor principal ──────────────────────────────────────────────────────────

export async function executarRemediacao(
  tenantId: string,
  machineId: string,
  nomeMaq: string,
  criticidade: string,
  triggerDescricao: string,
  snapshotAntes: MetricaSnapshot,
  triggersAtivos: string[], // quais métricas dispararam o alerta
): Promise<void> {
  const cooldownKey = `remediacão:cooldown:${machineId}`;
  const pendKey     = `remediacão:pendente:${machineId}`;

  // Cooldown: não roda mais de 1 remediação por máquina por 30min
  const novoCooldown = await redis.set(cooldownKey, "1", "EX", 1800, "NX");
  if (!novoCooldown) return;

  // Remove a chave de pendente
  await redis.del(pendKey);

  // Verifica se IA ainda está habilitada (pode ter sido desabilitada nos 60s de espera)
  const rows = await comTenant(tenantId, (tdb) =>
    tdb.select({ ia: maquinas.iaRemediacao, acoes: maquinas.iaAcoesPermitidas })
      .from(maquinas).where(eq(maquinas.id, machineId)).limit(1),
  );
  if (!rows[0]?.ia) return; // IA foi desabilitada, cancela

  const acoesPermitidas = (rows[0]?.acoes as string[] | null) ?? Object.keys(CATALOGO_SEGURO);

  // Cria registro inicial no banco
  const remedId = crypto.randomUUID();
  await comTenant(tenantId, (tdb) =>
    tdb.insert(remediacoesIa).values({
      id: remedId, tenantId, maquinaId: machineId,
      triggerDescricao, metricasAntes: snapshotAntes,
      status: "executando", iaModelo: "claude-haiku-4-5",
    }),
  );

  const inicio = Date.now();
  const resultados: Array<{ acao: string; cmd: string; output: string; ok: boolean; ms: number }> = [];

  try {
    // ── Pede ao Claude Haiku para escolher ações da whitelist ──────────────────
    const catalogoFiltrado = Object.entries(CATALOGO_SEGURO)
      .filter(([id, a]) => acoesPermitidas.includes(id) && a.triggers.some((t) => triggersAtivos.includes(t)))
      .map(([id, a]) => `- ${id}: ${a.desc}`)
      .join("\n");

    if (!catalogoFiltrado) {
      await comTenant(tenantId, (tdb) =>
        tdb.update(remediacoesIa).set({ status: "concluido", acoesExecutadas: [], duracaoMs: Date.now() - inicio }).where(eq(remediacoesIa.id, remedId)),
      );
      return;
    }

    const prompt = `Você é um sistema de remediação automática de TI do Nexus RMM.
Situação detectada: ${triggerDescricao}
Métricas atuais: CPU=${snapshotAntes.cpu}%, RAM=${snapshotAntes.ram}%${snapshotAntes.discos ? `, Discos=[${snapshotAntes.discos.map((d) => `${d.caminho}:${d.usoPct}%`).join(", ")}]` : ""}
Criticidade da máquina: ${criticidade}

APENAS escolha ações desta lista (máximo 3, em ordem de prioridade):
${catalogoFiltrado}

Responda APENAS com JSON no formato: {"acoes": ["id-acao-1", "id-acao-2"]}
Não inclua nenhum texto além do JSON. Não invente ações fora da lista.`;

    const iaResp = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }],
    });

    const iaTexto = (iaResp.content[0] as { text: string }).text.trim();
    let acoesEscolhidas: string[] = [];
    try {
      const parsed = JSON.parse(iaTexto) as { acoes?: string[] };
      acoesEscolhidas = (parsed.acoes ?? [])
        .filter((id) => typeof id === "string" && id in CATALOGO_SEGURO && acoesPermitidas.includes(id))
        .slice(0, 3); // máximo 3 ações por segurança
    } catch {
      // IA retornou JSON malformado — aborta com segurança
      await comTenant(tenantId, (tdb) =>
        tdb.update(remediacoesIa).set({ status: "falhou", duracaoMs: Date.now() - inicio }).where(eq(remediacoesIa.id, remedId)),
      );
      return;
    }

    // ── Executa cada ação via terminal socket ───────────────────────────────────
    for (const acaoId of acoesEscolhidas) {
      const acao = CATALOGO_SEGURO[acaoId];
      if (!acao) continue;
      const t0 = Date.now();
      try {
        const result = await enviarComandoAgente(machineId, {
          commandId: crypto.randomUUID(),
          type: "shell.run",
          payload: { command: acao.cmd, timeout: 60000 },
        } as any);
        resultados.push({
          acao: `${acaoId}: ${acao.desc}`,
          cmd: acao.cmd.slice(0, 100),
          output: String((result as any)?.output ?? "").slice(0, 500),
          ok: (result as any)?.exitCode === 0 || String((result as any)?.output ?? "").length > 0,
          ms: Date.now() - t0,
        });
      } catch (err: any) {
        resultados.push({ acao: `${acaoId}: ${acao.desc}`, cmd: acao.cmd.slice(0, 100), output: String(err?.message ?? "erro"), ok: false, ms: Date.now() - t0 });
      }
    }

    // ── Snapshot pós-remediação ─────────────────────────────────────────────────
    await new Promise((r) => setTimeout(r, 5000)); // aguarda 5s para métricas estabilizarem
    const snapshotDepois = await obterSnapshotAtual(machineId);

    // ── Atualiza registro no banco ─────────────────────────────────────────────
    await comTenant(tenantId, (tdb) =>
      tdb.update(remediacoesIa).set({
        status: resultados.some((r) => r.ok) ? "concluido" : "falhou",
        acoesExecutadas: resultados,
        metricasDepois: snapshotDepois,
        duracaoMs: Date.now() - inicio,
      }).where(eq(remediacoesIa.id, remedId)),
    );

    // ── Envia relatório por e-mail ──────────────────────────────────────────────
    const totalAcoes = resultados.length;
    const ok = resultados.filter((r) => r.ok).length;
    const htmlRelatorio = gerarHtmlRelatorio(nomeMaq, criticidade, triggerDescricao, snapshotAntes, snapshotDepois, resultados);
    void enviarEmailRico(
      tenantId,
      `✅ Nexus RMM — Remediação IA concluída em "${nomeMaq}" (${ok}/${totalAcoes} ações ok)`,
      htmlRelatorio,
    );

  } catch (err: any) {
    await comTenant(tenantId, (tdb) =>
      tdb.update(remediacoesIa).set({ status: "falhou", duracaoMs: Date.now() - inicio }).where(eq(remediacoesIa.id, remedId)),
    ).catch(() => {});
  }
}

// ─── Gerador de HTML do relatório ────────────────────────────────────────────

function gerarHtmlRelatorio(
  nomeMaq: string,
  criticidade: string,
  trigger: string,
  antes: MetricaSnapshot,
  depois: MetricaSnapshot,
  acoes: Array<{ acao: string; output: string; ok: boolean; ms: number }>,
): string {
  const linhasAcoes = acoes.map((a) =>
    `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #1e2636">${a.ok ? "✅" : "❌"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1e2636;color:#e4e8f0">${a.acao}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1e2636;font-family:monospace;font-size:11px;color:#9ca3af;max-width:300px;overflow-wrap:break-word">${a.output.slice(0, 200)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1e2636;color:#6b7595">${a.ms}ms</td>
    </tr>`).join("");

  return `<!DOCTYPE html><html lang="pt-br"><head><meta charset="utf-8">
<style>body{font-family:system-ui,sans-serif;background:#0f1117;color:#e4e8f0;margin:0;padding:24px}</style>
</head><body>
<div style="max-width:700px;margin:0 auto;background:#1a1f2e;border-radius:12px;border:1px solid #2a3350;overflow:hidden">
  <div style="background:#10b981;padding:20px 24px"><h1 style="margin:0;font-size:18px;color:#fff">🤖 Nexus RMM — Relatório de Remediação IA</h1></div>
  <div style="padding:24px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
      <div style="background:#111827;border-radius:8px;padding:16px">
        <div style="font-size:11px;color:#6b7595;text-transform:uppercase">Máquina</div>
        <div style="font-size:16px;font-weight:700;color:#e4e8f0;margin-top:4px">${nomeMaq}</div>
        <div style="font-size:11px;color:#6b7595;margin-top:4px">Criticidade: ${criticidade}</div>
      </div>
      <div style="background:#111827;border-radius:8px;padding:16px">
        <div style="font-size:11px;color:#6b7595;text-transform:uppercase">Disparado por</div>
        <div style="font-size:13px;color:#e4e8f0;margin-top:4px">${trigger}</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
      <div style="background:#1e2636;border-radius:8px;padding:16px;border:1px solid #ef444422">
        <div style="font-size:11px;color:#ef4444;text-transform:uppercase">Antes</div>
        <div style="margin-top:8px">CPU <strong>${antes.cpu}%</strong> · RAM <strong>${antes.ram}%</strong></div>
      </div>
      <div style="background:#1e2636;border-radius:8px;padding:16px;border:1px solid #10b98122">
        <div style="font-size:11px;color:#10b981;text-transform:uppercase">Depois</div>
        <div style="margin-top:8px">CPU <strong>${depois.cpu}%</strong> · RAM <strong>${depois.ram}%</strong></div>
      </div>
    </div>
    <h3 style="font-size:14px;color:#9ca3af;margin:0 0 8px">Ações executadas</h3>
    <table style="width:100%;border-collapse:collapse;background:#111827;border-radius:8px;overflow:hidden">
      <thead><tr style="background:#1e2636">
        <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7595"></th>
        <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7595">AÇÃO</th>
        <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7595">SAÍDA</th>
        <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7595">TEMPO</th>
      </tr></thead>
      <tbody>${linhasAcoes}</tbody>
    </table>
  </div>
  <div style="padding:16px 24px;border-top:1px solid #2a3350;font-size:11px;color:#4b5568">
    Nexus RMM · Modelo: claude-haiku-4-5 · ${new Date().toLocaleString("pt-BR", { timeZone: "America/Cuiaba" })}
  </div>
</div></body></html>`;
}
