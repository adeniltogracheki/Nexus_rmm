import type { FastifyPluginAsync } from "fastify";
import { eq, and, gte, asc } from "drizzle-orm";
import { comTenant } from "../db/tenant";
import { maquinas, metricasHistorico } from "../db/schema";
import { redis } from "../redis";
import { requireEscopoMaquina } from "../escopo";

export const metricasRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/maquinas/:id/metricas — últimas amostras de CPU/RAM (ao vivo, via Redis).
  app.get("/api/maquinas/:id/metricas", { preHandler: [app.requireAuth, requireEscopoMaquina] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.auth!;
    try {
      const existe = await comTenant(tenantId, async (tdb) => {
        const r = await tdb.select({ id: maquinas.id }).from(maquinas).where(eq(maquinas.id, id)).limit(1);
        return r.length > 0;
      });
      if (!existe) return reply.code(404).send({ erro: "máquina não encontrada" });

      const raw = await redis.lrange(`maquina:${id}:metricas`, 0, 29);
      const amostras = raw
        .map((s) => {
          try {
            return JSON.parse(s);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .reverse(); // cronológico (mais antigo -> mais novo)
      return reply.send({ amostras, atual: amostras[amostras.length - 1] || null });
    } catch (err) {
      app.log.error({ err, id }, "Erro ao obter métricas");
      return reply.code(500).send({ erro: "erro ao obter métricas" });
    }
  });

  // GET /api/maquinas/:id/metricas/historico?horas=24 — tendência (Postgres).
  app.get("/api/maquinas/:id/metricas/historico", { preHandler: [app.requireAuth, requireEscopoMaquina] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.auth!;
    const horas = Math.min(168, Math.max(1, Number((req.query as { horas?: string })?.horas) || 24));
    try {
      const desde = new Date(Date.now() - horas * 3600 * 1000);
      const dados = await comTenant(tenantId, (tdb) =>
        tdb
          .select({ cpu: metricasHistorico.cpu, ram: metricasHistorico.ram, em: metricasHistorico.criadoEm })
          .from(metricasHistorico)
          .where(and(eq(metricasHistorico.maquinaId, id), gte(metricasHistorico.criadoEm, desde)))
          .orderBy(asc(metricasHistorico.criadoEm))
          .limit(2000),
      );
      return reply.send({ horas, amostras: dados });
    } catch (err) {
      app.log.error({ err, id }, "Erro ao obter histórico de métricas");
      return reply.code(500).send({ erro: "erro ao obter histórico" });
    }
  });
};
