import type { FastifyPluginAsync } from "fastify";
import { desc, eq, sql } from "drizzle-orm";
import { comTenant } from "../db/tenant";
import { alertas } from "../db/schema";

export const alertasRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/alertas — últimos 50 alertas + total de não lidos
  app.get("/api/alertas", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { tenantId } = req.auth!;
    try {
      const resultado = await comTenant(tenantId, async (tdb) => {
        const lista = await tdb
          .select()
          .from(alertas)
          .orderBy(desc(alertas.criadoEm))
          .limit(50);
        const naoLidasRows = await tdb
          .select({ c: sql<number>`count(*)::int` })
          .from(alertas)
          .where(eq(alertas.lida, false));
        return { lista, naoLidas: naoLidasRows[0]?.c ?? 0 };
      });
      return reply.send({ alertas: resultado.lista, naoLidas: resultado.naoLidas });
    } catch (err) {
      app.log.error({ err, tenantId }, "Erro ao listar alertas");
      return reply.code(500).send({ erro: "erro ao listar alertas" });
    }
  });

  // POST /api/alertas/:id/lida — marca um alerta como lido
  app.post("/api/alertas/:id/lida", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const { id } = req.params as { id: string };
    try {
      await comTenant(tenantId, async (tdb) => {
        await tdb.update(alertas).set({ lida: true }).where(eq(alertas.id, id));
      });
      return reply.send({ ok: true });
    } catch (err) {
      app.log.error({ err, tenantId, id }, "Erro ao marcar alerta");
      return reply.code(500).send({ erro: "erro ao marcar alerta" });
    }
  });

  // POST /api/alertas/marcar-lidas — marca todos como lidos
  app.post("/api/alertas/marcar-lidas", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { tenantId } = req.auth!;
    try {
      await comTenant(tenantId, async (tdb) => {
        await tdb.update(alertas).set({ lida: true }).where(eq(alertas.lida, false));
      });
      return reply.send({ ok: true });
    } catch (err) {
      app.log.error({ err, tenantId }, "Erro ao marcar alertas como lidos");
      return reply.code(500).send({ erro: "erro ao marcar alertas" });
    }
  });
};
