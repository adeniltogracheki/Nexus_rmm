import type { FastifyPluginAsync } from "fastify";
import { eq, and, isNotNull, gt, asc } from "drizzle-orm";
import { comTenant } from "../db/tenant";
import { maquinas, inventarios, metricasHistorico } from "../db/schema";
import { requireEscopoMaquina } from "../escopo";
import { calcularHealthScores } from "../lib/health-score";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/maquinas/:id/health-score
   * Retorna o health score (0-100) e componentes de uma única máquina do tenant.
   */
  app.get(
    "/api/maquinas/:id/health-score",
    { preHandler: [app.requireAuth, requireEscopoMaquina] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { tenantId } = req.auth!;

      try {
        const resultado = await comTenant(tenantId, async (tdb) => {
          const rows = await tdb
            .select({ id: maquinas.id, online: maquinas.online })
            .from(maquinas)
            .where(eq(maquinas.id, id))
            .limit(1);
          const maq = rows[0] ?? null;
          if (!maq) return null;

          const map = await calcularHealthScores(tdb, tenantId, [{ id: maq.id, online: maq.online }]);
          return map.get(maq.id) ?? null;
        });

        if (resultado === null) {
          return reply.code(404).send({ erro: "máquina não encontrada" });
        }

        return reply.send(resultado);
      } catch (err) {
        app.log.error({ err, tenantId, maquinaId: id }, "Erro ao calcular health score");
        return reply.code(500).send({ erro: "erro interno ao calcular health score" });
      }
    },
  );

  /**
   * GET /api/maquinas/:id/disco/previsao
   * Retorna previsão de esgotamento de disco por regressão linear sobre o histórico de amostras.
   */
  app.get(
    "/api/maquinas/:id/disco/previsao",
    { preHandler: [app.requireAuth, requireEscopoMaquina] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { tenantId } = req.auth!;

      try {
        const resultado = await comTenant(tenantId, async (tdb) => {
          // 1. Amostras dos últimos 14 dias com disco não-nulo
          const amostras = await tdb
            .select({
              disco: metricasHistorico.disco,
              em: metricasHistorico.criadoEm,
            })
            .from(metricasHistorico)
            .where(
              and(
                eq(metricasHistorico.tenantId, tenantId),
                eq(metricasHistorico.maquinaId, id),
                isNotNull(metricasHistorico.disco),
                gt(metricasHistorico.criadoEm, new Date(Date.now() - 14 * 86400_000)),
              ),
            )
            .orderBy(asc(metricasHistorico.criadoEm));

          // 2. Sem amostras suficientes — retorna snapshot do inventário
          if (amostras.length < 2) {
            const inv = await tdb
              .select({ hardware: inventarios.hardware })
              .from(inventarios)
              .where(and(eq(inventarios.tenantId, tenantId), eq(inventarios.maquinaId, id)))
              .limit(1);

            const discosInv = (inv[0]?.hardware as any)?.discos ?? [];
            return {
              suficiente: false,
              amostras: amostras.length,
              discos: discosInv.map((d: any) => ({
                caminho: d.caminho,
                usoPct:
                  d.tamanhoBytes > 0
                    ? Math.round(((d.tamanhoBytes - d.livreBytes) / d.tamanhoBytes) * 100)
                    : null,
                tamanhoGB: Math.round(d.tamanhoBytes / 1073741824),
                livreGB: Math.round(d.livreBytes / 1073741824),
                previsaoDias: null,
                crescimentoPorDia: null,
              })),
            };
          }

          // 3. Regressão linear simples por caminho de disco
          type DiscoSample = { caminho: string; usoPct: number; em: Date };
          const discoPorCaminho = new Map<string, DiscoSample[]>();

          for (const amostra of amostras) {
            const discos = (amostra.disco as Array<{ caminho: string; usoPct: number }>) ?? [];
            const em = amostra.em;
            for (const d of discos) {
              if (!discoPorCaminho.has(d.caminho)) discoPorCaminho.set(d.caminho, []);
              discoPorCaminho.get(d.caminho)!.push({ caminho: d.caminho, usoPct: d.usoPct, em });
            }
          }

          const resultado: Array<{
            caminho: string;
            usoPct: number;
            crescimentoPorDia: number;
            previsaoDias: number | null;
            alerta: string | null;
          }> = [];

          for (const [caminho, pontos] of discoPorCaminho) {
            if (pontos.length < 2) continue;
            const primeiro = pontos[0]!;
            const ultimo = pontos[pontos.length - 1]!;
            const deltaDias = (ultimo.em.getTime() - primeiro.em.getTime()) / 86400_000;
            const deltaUso = ultimo.usoPct - primeiro.usoPct;
            const crescimentoPorDia = deltaDias > 0 ? deltaUso / deltaDias : 0;
            const restante = 100 - ultimo.usoPct;
            const previsaoDias =
              crescimentoPorDia > 0 ? Math.round(restante / crescimentoPorDia) : null;

            resultado.push({
              caminho,
              usoPct: ultimo.usoPct,
              crescimentoPorDia: Math.round(crescimentoPorDia * 10) / 10,
              previsaoDias,
              alerta:
                ultimo.usoPct >= 85 ? "critico" : ultimo.usoPct >= 70 ? "aviso" : null,
            });
          }

          return { suficiente: true, amostras: amostras.length, discos: resultado };
        });

        return reply.send(resultado);
      } catch (err) {
        app.log.error({ err, tenantId, maquinaId: id }, "Erro ao calcular previsão de disco");
        return reply.code(500).send({ erro: "erro interno ao calcular previsão de disco" });
      }
    },
  );
};
