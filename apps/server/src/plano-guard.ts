import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { tenants } from "./db/schema";
import { planoTem, planoDe } from "./planos";

const GRACA_MS = 3 * 86400000; // 3 dias de carência após o vencimento da assinatura

const cache = new Map<string, { plano: string; trialExpiraEm: Date | null; pagoAte: Date | null; criadoEm: Date | null; exp: number }>();

async function dadosTenant(tenantId: string) {
  const c = cache.get(tenantId);
  if (c && c.exp > Date.now()) return c;
  const t = (await db
    .select({ plano: tenants.plano, trialExpiraEm: tenants.trialExpiraEm, pagoAte: tenants.pagoAte, criadoEm: tenants.criadoEm })
    .from(tenants).where(eq(tenants.id, tenantId)).limit(1))[0];
  const d = { plano: t?.plano || "trial", trialExpiraEm: t?.trialExpiraEm ?? null, pagoAte: t?.pagoAte ?? null, criadoEm: t?.criadoEm ?? null, exp: Date.now() + 30_000 };
  cache.set(tenantId, d);
  return d;
}

export function limparCachePlano(tenantId: string): void {
  cache.delete(tenantId);
}

export interface AcessoInfo {
  plano: string;
  bloqueado: boolean;
  motivo: "trial" | "vencido" | null;
  vencimento: Date | null;
  diasRestantes: number;
}

/** Estado de acesso do tenant: trial vencido ou assinatura paga vencida. */
export async function acessoInfo(tenantId: string): Promise<AcessoInfo> {
  const d = await dadosTenant(tenantId);
  const agora = Date.now();
  if (d.plano === "trial") {
    const venc = d.trialExpiraEm ? new Date(d.trialExpiraEm) : d.criadoEm ? new Date(new Date(d.criadoEm).getTime() + 7 * 86400000) : new Date(agora + 7 * 86400000);
    return { plano: d.plano, bloqueado: agora > venc.getTime(), motivo: "trial", vencimento: venc, diasRestantes: Math.max(0, Math.ceil((venc.getTime() - agora) / 86400000)) };
  }
  // Planos pagos: bloqueia se passou do pagoAte + carência. Sem pagoAte (ex.: setado manual pelo super admin) = liberado.
  if ((d.plano === "essencial" || d.plano === "pro") && d.pagoAte) {
    const venc = new Date(d.pagoAte);
    return { plano: d.plano, bloqueado: agora > venc.getTime() + GRACA_MS, motivo: "vencido", vencimento: venc, diasRestantes: Math.max(0, Math.ceil((venc.getTime() - agora) / 86400000)) };
  }
  return { plano: d.plano, bloqueado: false, motivo: null, vencimento: d.pagoAte ?? null, diasRestantes: 0 };
}

/** Bloqueia a rota se o acesso está suspenso (trial/assinatura vencidos) ou se o plano não inclui a feature. */
export function requirePlano(feature: string) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) { reply.code(401).send({ erro: "não autenticado" }); return; }
    const a = await acessoInfo(tenantId);
    if (a.bloqueado) { reply.code(402).send({ erro: a.motivo === "trial" ? "Seu teste de 7 dias acabou. Assine para continuar." : "Sua assinatura venceu. Renove para continuar.", upgrade: true, bloqueado: true }); return; }
    const d = await dadosTenant(tenantId);
    if (!planoTem(d.plano, feature)) {
      reply.code(402).send({ erro: "Recurso não incluído no seu plano. Faça upgrade para liberar.", upgrade: true, feature });
    }
  };
}

/** Bloqueia se o acesso está suspenso (sem exigir feature específica). */
export async function requireAcessoAtivo(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tenantId = req.auth?.tenantId;
  if (!tenantId) return;
  const a = await acessoInfo(tenantId);
  if (a.bloqueado) reply.code(402).send({ erro: "Acesso suspenso. Assine/renove para continuar.", upgrade: true, bloqueado: true });
}

export async function featuresDoTenant(tenantId: string): Promise<string[]> {
  const d = await dadosTenant(tenantId);
  return planoDe(d.plano).features;
}
