import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { tenants, maquinas } from "../db/schema";
import { comTenant } from "../db/tenant";
import { PLANOS, FEATURES_LABEL, planoDe } from "../planos";
import { requireSuperAdmin } from "../superadmin";

export const planosRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/plano", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const t = (await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1))[0];
    const plano = t?.plano || "trial";
    const usadas = await comTenant(tenantId, (tdb) => tdb.select({ id: maquinas.id }).from(maquinas).where(eq(maquinas.arquivada, false)));
    return reply.send({
      plano,
      info: planoDe(plano),
      maquinasUsadas: usadas.length,
      planos: PLANOS,
      featuresLabel: FEATURES_LABEL,
    });
  });

  // Troca de plano — SÓ super admin da plataforma (senão cliente se daria upgrade grátis).
  app.put("/api/plano", { preHandler: [app.requireAuth, app.requireMfa, requireSuperAdmin] }, async (req, reply) => {
    const p = z.object({ plano: z.enum(["trial", "essencial", "pro", "enterprise"]) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ erro: "plano inválido" });
    await db.update(tenants).set({ plano: p.data.plano }).where(eq(tenants.id, req.auth!.tenantId));
    return reply.send({ ok: true, plano: p.data.plano });
  });
};
