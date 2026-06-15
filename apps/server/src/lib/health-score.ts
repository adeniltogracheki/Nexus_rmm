import { sql } from "drizzle-orm";
import type { TenantDB } from "../db/tenant";

export interface HealthScoreComponentes {
  online: boolean;
  cpuMedia: number | null;
  ramMedia: number | null;
  discoUsoPct: number | null;
  uptimePct: number;
  alertasCriticos: number;
  alertasAvisos: number;
}

export interface HealthScoreResult {
  maquinaId: string;
  score: number;
  componentes: HealthScoreComponentes;
  tendencia: "melhorando" | "estavel" | "piorando";
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export async function calcularHealthScores(
  db: TenantDB,
  tenantId: string,
  maquinas: Array<{ id: string; online: boolean }>,
): Promise<Map<string, HealthScoreResult>> {
  const result = new Map<string, HealthScoreResult>();
  if (maquinas.length === 0) return result;

  const ids = maquinas.map((m) => m.id);
  // Formata lista de UUIDs para uso no sql template
  const idsLiteral = ids.map((id) => `'${id}'`).join(", ");

  // 5 queries em paralelo
  const [cpuRam2h, cpuRam1h3h, inventarios, presenca7d, alertas24h] = await Promise.all([
    // 1. CPU/RAM média últimas 2h
    db.execute(sql.raw(`
      SELECT maquina_id, AVG(cpu)::numeric AS cpu_avg, AVG(ram)::numeric AS ram_avg
      FROM metricas_historico
      WHERE tenant_id = '${tenantId}'
        AND maquina_id IN (${idsLiteral})
        AND criado_em > NOW() - INTERVAL '2 hours'
      GROUP BY maquina_id
    `)),

    // 2. CPU/RAM média de 1h a 3h atrás (para tendência)
    db.execute(sql.raw(`
      SELECT maquina_id, AVG(cpu)::numeric AS cpu_avg, AVG(ram)::numeric AS ram_avg
      FROM metricas_historico
      WHERE tenant_id = '${tenantId}'
        AND maquina_id IN (${idsLiteral})
        AND criado_em BETWEEN NOW() - INTERVAL '3 hours' AND NOW() - INTERVAL '1 hour'
      GROUP BY maquina_id
    `)),

    // 3. Disco: pega o primeiro disco do inventário mais recente por máquina
    db.execute(sql.raw(`
      SELECT DISTINCT ON (maquina_id)
        maquina_id,
        (hardware->'discos'->0->>'tamanhoBytes')::bigint AS total_bytes,
        (hardware->'discos'->0->>'livreBytes')::bigint AS livre_bytes
      FROM inventarios
      WHERE tenant_id = '${tenantId}'
        AND maquina_id IN (${idsLiteral})
      ORDER BY maquina_id, atualizado_em DESC
    `)),

    // 4. Presença nos últimos 7 dias para calcular uptime
    db.execute(sql.raw(`
      SELECT maquina_id, online, em
      FROM presenca_log
      WHERE tenant_id = '${tenantId}'
        AND maquina_id IN (${idsLiteral})
        AND em > NOW() - INTERVAL '7 days'
      ORDER BY maquina_id, em ASC
    `)),

    // 5. Alertas por severidade nas últimas 24h
    db.execute(sql.raw(`
      SELECT maquina_id, severidade, COUNT(*)::integer AS qty
      FROM alertas
      WHERE tenant_id = '${tenantId}'
        AND maquina_id IN (${idsLiteral})
        AND criado_em > NOW() - INTERVAL '24 hours'
      GROUP BY maquina_id, severidade
    `)),
  ]);

  // Indexar resultados por maquinaId
  const cpuRam2hMap = new Map<string, { cpuAvg: number; ramAvg: number }>();
  for (const row of cpuRam2h.rows as any[]) {
    cpuRam2hMap.set(row.maquina_id, {
      cpuAvg: parseFloat(row.cpu_avg ?? "0"),
      ramAvg: parseFloat(row.ram_avg ?? "0"),
    });
  }

  const cpuRam1h3hMap = new Map<string, { cpuAvg: number; ramAvg: number }>();
  for (const row of cpuRam1h3h.rows as any[]) {
    cpuRam1h3hMap.set(row.maquina_id, {
      cpuAvg: parseFloat(row.cpu_avg ?? "0"),
      ramAvg: parseFloat(row.ram_avg ?? "0"),
    });
  }

  const discoMap = new Map<string, number | null>();
  for (const row of inventarios.rows as any[]) {
    const total = Number(row.total_bytes);
    const livre = Number(row.livre_bytes);
    if (total > 0) {
      discoMap.set(row.maquina_id, Math.round(((total - livre) / total) * 100));
    } else {
      discoMap.set(row.maquina_id, null);
    }
  }

  // Calcular uptime por máquina a partir dos eventos de presença
  const presencaRows = presenca7d.rows as any[];
  const presencaPorMaq = new Map<string, { online: boolean; em: Date }[]>();
  for (const row of presencaRows) {
    if (!presencaPorMaq.has(row.maquina_id)) {
      presencaPorMaq.set(row.maquina_id, []);
    }
    presencaPorMaq.get(row.maquina_id)!.push({ online: row.online, em: new Date(row.em) });
  }

  const uptimeMap = new Map<string, number>();
  const janelaMs = 7 * 24 * 60 * 60 * 1000;
  const agora = Date.now();
  const inicio7d = agora - janelaMs;

  for (const maq of maquinas) {
    const eventos = presencaPorMaq.get(maq.id) ?? [];
    if (eventos.length === 0) {
      // Se não há eventos de presença, usa estado atual
      uptimeMap.set(maq.id, maq.online ? 100 : 0);
      continue;
    }

    let totalOnlineMs = 0;
    const primeiro = eventos[0]!;
    let estadoAtual = primeiro.online;
    let tsAtual = Math.max(primeiro.em.getTime(), inicio7d);

    for (let i = 1; i < eventos.length; i++) {
      const ev = eventos[i]!;
      const tsEv = ev.em.getTime();
      if (estadoAtual) {
        totalOnlineMs += tsEv - tsAtual;
      }
      estadoAtual = ev.online;
      tsAtual = tsEv;
    }
    // Último período até agora
    if (estadoAtual) {
      totalOnlineMs += agora - tsAtual;
    }

    uptimeMap.set(maq.id, Math.min(100, (totalOnlineMs / janelaMs) * 100));
  }

  // Indexar alertas
  const alertasCriticosMap = new Map<string, number>();
  const alertasAvisosMap = new Map<string, number>();
  for (const row of alertas24h.rows as any[]) {
    if (!row.maquina_id) continue;
    const qty = Number(row.qty);
    if (row.severidade === "critico") {
      alertasCriticosMap.set(row.maquina_id, (alertasCriticosMap.get(row.maquina_id) ?? 0) + qty);
    } else if (row.severidade === "aviso") {
      alertasAvisosMap.set(row.maquina_id, (alertasAvisosMap.get(row.maquina_id) ?? 0) + qty);
    }
  }

  // Calcular score por máquina
  for (const maq of maquinas) {
    const metricas2h = cpuRam2hMap.get(maq.id) ?? null;
    const metricas1h3h = cpuRam1h3hMap.get(maq.id) ?? null;

    const cpuMedia = metricas2h ? Math.round(metricas2h.cpuAvg) : null;
    const ramMedia = metricas2h ? Math.round(metricas2h.ramAvg) : null;
    const discoUsoPct = discoMap.has(maq.id) ? (discoMap.get(maq.id) ?? null) : null;
    const uptimePct = uptimeMap.get(maq.id) ?? 0;
    const alertasCriticos = alertasCriticosMap.get(maq.id) ?? 0;
    const alertasAvisos = alertasAvisosMap.get(maq.id) ?? 0;

    // Se não há nenhum dado de métricas, retorna null (máquina recém instalada)
    const semDados = cpuMedia === null && ramMedia === null && uptimePct === 0 && alertasCriticos === 0 && alertasAvisos === 0 && discoUsoPct === null;
    if (semDados && !maq.online) {
      result.set(maq.id, {
        maquinaId: maq.id,
        score: 0,
        componentes: { online: false, cpuMedia: null, ramMedia: null, discoUsoPct: null, uptimePct: 0, alertasCriticos: 0, alertasAvisos: 0 },
        tendencia: "estavel",
      });
      continue;
    }

    const base = maq.online ? 40 : 0;
    const cpuScore = maq.online && cpuMedia !== null ? (100 - cpuMedia) * 0.20 : 0;
    const ramScore = maq.online && ramMedia !== null ? (100 - ramMedia) * 0.15 : 0;
    const discoScore = discoUsoPct !== null ? (100 - discoUsoPct) * 0.10 : 5;
    const uptimeScore = uptimePct * 0.15;
    const penalidade = alertasCriticos * 8 + alertasAvisos * 3;

    const scoreRaw = base + cpuScore + ramScore + discoScore + uptimeScore - penalidade;
    const score = Math.round(clamp(scoreRaw, 0, 100));

    // Tendência: compara CPU última 1h vs 1h-3h atrás
    let tendencia: "melhorando" | "estavel" | "piorando" = "estavel";
    if (metricas2h && metricas1h3h) {
      const delta = metricas2h.cpuAvg - metricas1h3h.cpuAvg;
      if (delta > 10) tendencia = "piorando";
      else if (delta < -10) tendencia = "melhorando";
    }

    result.set(maq.id, {
      maquinaId: maq.id,
      score,
      componentes: { online: maq.online, cpuMedia, ramMedia, discoUsoPct, uptimePct: Math.round(uptimePct), alertasCriticos, alertasAvisos },
      tendencia,
    });
  }

  return result;
}
