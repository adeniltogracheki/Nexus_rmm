/**
 * engine.ts — Motor de monitoramento com janela de tempo.
 * Chamado a cada `agent:metrics` recebido pelo gateway.
 * Detecta violações sustentadas (ex: CPU > 90% por > 2min) e dispara:
 *   1. Alerta registrado no banco
 *   2. Notificações (Email, Telegram, WhatsApp)
 *   3. IA remediação (se habilitada — aguarda 60s, best-effort)
 */
import { eq } from "drizzle-orm";
import { redis } from "../redis";
import { comTenant } from "../db/tenant";
import { maquinas, regrasAlerta } from "../db/schema";
import { criarAlerta } from "../gateway/agent";
import { despacharAlerta } from "../notificacoes/dispatcher";

// Chave Redis: momento em que o threshold foi PRIMEIRO violado (NX → só escrita uma vez)
//   thresh:cpu:{machineId}   → timestamp ms
//   thresh:ram:{machineId}   → timestamp ms
// Cooldown depois de disparar (evita spam de alertas):
//   alerta:mon:{machineId}:{metric} → "1" com TTL
// Cooldown de remediação:
//   remediacão:cooldown:{machineId} → "1" com TTL

export interface MetricaSnapshot {
  cpu: number;
  ram: number;
  discos?: Array<{ caminho: string; usoPct: number }>;
}

/** Carrega as regras do tenant (cache Redis 5min). */
async function carregarRegras(tenantId: string) {
  const cacheKey = `regras-alerta:${tenantId}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached) as { cpuLimitePct: number; cpuJanelaMin: number; ramLimitePct: number; ramJanelaMin: number; discoLivreMinPct: number; iaRemediaCaoGlobal: boolean };

  const rows = await comTenant(tenantId, (tdb) =>
    tdb.select().from(regrasAlerta).where(eq(regrasAlerta.tenantId, tenantId)).limit(1),
  );
  // Se não configurado, usa defaults
  const regras = rows[0] ?? {
    cpuLimitePct: 90, cpuJanelaMin: 2,
    ramLimitePct: 90, ramJanelaMin: 2,
    discoLivreMinPct: 10, iaRemediaCaoGlobal: false,
  };
  await redis.set(cacheKey, JSON.stringify(regras), "EX", 300);
  return regras;
}

/** Verifica se a máquina tem IA habilitada (tenant + máquina devem estar ativas). */
async function iaPermitida(tenantId: string, machineId: string, regras: { iaRemediaCaoGlobal: boolean }): Promise<boolean> {
  if (!regras.iaRemediaCaoGlobal) return false;
  const rows = await comTenant(tenantId, (tdb) =>
    tdb.select({ ia: maquinas.iaRemediacao, criticidade: maquinas.criticidade })
      .from(maquinas).where(eq(maquinas.id, machineId)).limit(1),
  );
  return rows[0]?.ia === true;
}

/** Verifica threshold com janela de tempo e dispara alertas se necessário. */
async function verificarMetrica(
  tenantId: string,
  machineId: string,
  nomeMaq: string,
  criticidade: string,
  metrica: "cpu" | "ram",
  valorAtual: number,
  limite: number,
  janelaMin: number,
  snapshot: MetricaSnapshot,
  iaGlobal: boolean,
): Promise<void> {
  const keyInicio  = `thresh:${metrica}:${machineId}`;
  const keyCooldown = `alerta:mon:${machineId}:${metrica}`;

  if (valorAtual >= limite) {
    // Registra o início da violação (só na primeira vez — NX)
    await redis.set(keyInicio, String(Date.now()), "EX", (janelaMin + 5) * 60, "NX");

    // Verifica se a janela foi ultrapassada
    const inicioStr = await redis.get(keyInicio);
    if (!inicioStr) return;
    const inicio = Number(inicioStr);
    const decorrido = (Date.now() - inicio) / 1000 / 60; // minutos

    if (decorrido >= janelaMin) {
      // Cooldown: não dispara novamente em 30min para a mesma métrica
      const novoCooldown = await redis.set(keyCooldown, "1", "EX", 1800, "NX");
      if (!novoCooldown) return; // já disparou recentemente

      await redis.del(keyInicio); // reseta a janela após disparar

      const sev = criticidade === "missao_critica" || criticidade === "critico" ? "critico" : "aviso";
      const label = metrica === "cpu" ? "CPU" : "Memória RAM";
      const msg = `${label} em ${valorAtual}% por ${Math.round(decorrido)} min em "${nomeMaq}" (criticidade: ${criticidade})`;

      await criarAlerta(tenantId, machineId, metrica, sev, msg);

      // Notificação rica
      void despacharAlerta(tenantId, {
        severidade: sev,
        tipo: metrica,
        mensagem: msg,
        maquinaNome: nomeMaq,
        criticidade,
      });

      // Solicita aprovação humana antes de remediar (fluxo com Telegram/WhatsApp/web)
      const regras2 = { iaRemediaCaoGlobal: iaGlobal };
      const podeRemediar = await iaPermitida(tenantId, machineId, regras2);
      if (podeRemediar) {
        void import("./aprovacaoRemediacao").then(({ criarAprovacaoPendente }) =>
          criarAprovacaoPendente(tenantId, machineId, nomeMaq, criticidade, msg, snapshot, [metrica])
            .catch(() => {}),
        ).catch(() => {});
      }
    }
  } else {
    // Métricas voltaram ao normal: remove o rastreador de início
    await redis.del(keyInicio);
  }
}

/** Ponto de entrada chamado pelo agent gateway em cada `agent:metrics`. */
export async function avaliarMetricas(
  tenantId: string,
  machineId: string,
  nomeMaq: string,
  snapshot: MetricaSnapshot,
): Promise<void> {
  try {
    const regras = await carregarRegras(tenantId);

    // Busca criticidade da máquina
    const rows = await comTenant(tenantId, (tdb) =>
      tdb.select({ criticidade: maquinas.criticidade }).from(maquinas).where(eq(maquinas.id, machineId)).limit(1),
    );
    const criticidade = rows[0]?.criticidade ?? "operacional";

    // Verificações paralelas de CPU e RAM
    await Promise.all([
      verificarMetrica(tenantId, machineId, nomeMaq, criticidade, "cpu", snapshot.cpu, regras.cpuLimitePct, regras.cpuJanelaMin, snapshot, regras.iaRemediaCaoGlobal),
      verificarMetrica(tenantId, machineId, nomeMaq, criticidade, "ram", snapshot.ram, regras.ramLimitePct, regras.ramJanelaMin, snapshot, regras.iaRemediaCaoGlobal),
    ]);

    // Disco: threshold simples (sem janela — disco não oscila rápido)
    if (snapshot.discos) {
      for (const d of snapshot.discos) {
        const pctLivre = 100 - d.usoPct;
        if (pctLivre <= regras.discoLivreMinPct) {
          const ck = `alerta:disco:mon:${machineId}:${d.caminho}`;
          const novo = await redis.set(ck, "1", "EX", 21600, "NX"); // cooldown 6h
          if (novo) {
            const msg = `Disco ${d.caminho} com apenas ${Math.round(pctLivre)}% livre em "${nomeMaq}"`;
            const sev = pctLivre <= 5 ? "critico" : "aviso";
            await criarAlerta(tenantId, machineId, "disco", sev, msg);
            void despacharAlerta(tenantId, { severidade: sev, tipo: "disco", mensagem: msg, maquinaNome: nomeMaq, criticidade });
          }
        }
      }
    }
  } catch {
    // engine é best-effort — nunca derruba o gateway
  }
}
