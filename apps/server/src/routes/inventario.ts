import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { comTenant } from "../db/tenant";
import { maquinas, inventarios } from "../db/schema";
import { requireEscopoMaquina } from "../escopo";

export const inventarioRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/maquinas/:id/inventario
  app.get(
    "/api/maquinas/:id/inventario",
    { preHandler: [app.requireAuth, requireEscopoMaquina] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { tenantId } = req.auth!;

      try {
        const inv = await comTenant(tenantId, async (tdb) => {
          // Verifica se a máquina existe no tenant (RLS do Postgres garante o isolamento)
          const m = await tdb
            .select()
            .from(maquinas)
            .where(eq(maquinas.id, id))
            .limit(1);

          if (m.length === 0) {
            return null;
          }

          // Busca o inventário correspondente à máquina
          const records = await tdb
            .select()
            .from(inventarios)
            .where(eq(inventarios.maquinaId, id))
            .limit(1);

          return records[0] || null;
        });

        if (inv === null) {
          return reply.code(404).send({ erro: "Inventário não encontrado para esta máquina" });
        }

        return reply.send(inv);
      } catch (err) {
        app.log.error({ err, tenantId, machineId: id }, "Erro ao obter inventário da máquina");
        return reply.code(500).send({ erro: "Erro interno ao obter inventário" });
      }
    }
  );
};
