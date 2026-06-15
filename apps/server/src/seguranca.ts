import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "./db";
import { configSeguranca } from "./db/schema";

let cache = { apenasBrasil: false, forcar2fa: false, nomeMarca: "", logoUrl: "" };

export async function carregarConfigSeguranca(): Promise<void> {
  try {
    const r = await db.select().from(configSeguranca).where(eq(configSeguranca.id, "global")).limit(1);
    if (r[0]) cache = { apenasBrasil: r[0].apenasBrasil, forcar2fa: r[0].forcar2fa, nomeMarca: (r[0] as any).nomeMarca || "", logoUrl: (r[0] as any).logoUrl || "" };
  } catch {
    // mantém o cache atual se falhar
  }
}

export function getConfigSeguranca(): { apenasBrasil: boolean; forcar2fa: boolean; nomeMarca: string; logoUrl: string } {
  return cache;
}

export async function salvarConfigSeguranca(p: { apenasBrasil?: boolean; forcar2fa?: boolean; nomeMarca?: string; logoUrl?: string }): Promise<void> {
  const upd: Record<string, unknown> = { atualizadoEm: new Date() };
  if (p.apenasBrasil !== undefined) upd.apenasBrasil = p.apenasBrasil;
  if (p.forcar2fa !== undefined) upd.forcar2fa = p.forcar2fa;
  if (p.nomeMarca !== undefined) upd.nomeMarca = p.nomeMarca;
  if (p.logoUrl !== undefined) upd.logoUrl = p.logoUrl;
  await db.update(configSeguranca).set(upd).where(eq(configSeguranca.id, "global"));
  await carregarConfigSeguranca();
}

// Bloqueio geográfico via Cloudflare (header CF-IPCountry). Só bloqueia se o header existir
// e for de fora do Brasil — assim não tranca ninguém antes do Cloudflare estar na frente.
export function registrarHooksSeguranca(app: FastifyInstance): void {
  app.addHook("onRequest", async (req, reply) => {
    if (!cache.apenasBrasil) return;
    // libera health/readiness pra monitoramento
    if (req.url === "/healthz" || req.url === "/readyz") return;
    const pais = String(req.headers["cf-ipcountry"] || "").toUpperCase();
    if (pais && pais !== "BR" && pais !== "XX" && pais !== "T1") {
      reply.code(451).send({ erro: "Acesso permitido somente do Brasil." });
    }
  });
}
