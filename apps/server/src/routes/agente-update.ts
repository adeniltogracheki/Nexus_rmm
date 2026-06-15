/**
 * Rotas de atualização manual de agente.
 * Segurança: requireAuth + requireMfa + requireOperador + escopo de máquina (anti-IDOR).
 * Toda ação é registrada na auditoria imutável (logs_servicos_windows).
 */
import type { FastifyPluginAsync } from "fastify";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { comTenant } from "../db/tenant";
import { maquinas, logsServicosWindows } from "../db/schema";
import { obterSocketAgente, marcarEmUpdate } from "../gateway/agent";
import { requireEscopoMaquina } from "../escopo";
import { config } from "../config";
import { Ev } from "@nexus/protocol";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Verifica que a máquina pertence ao tenant (anti-IDOR). */
async function maquinaDoTenant(
  tenantId: string,
  id: string,
): Promise<{ id: string; hostname: string; online: boolean; versaoAgente: string | null } | null> {
  const rows = await comTenant(tenantId, (tdb) =>
    tdb
      .select({ id: maquinas.id, hostname: maquinas.hostname, online: maquinas.online, versaoAgente: maquinas.versaoAgente })
      .from(maquinas)
      .where(eq(maquinas.id, id))
      .limit(1),
  );
  return rows[0] ?? null;
}

/** Grava na auditoria imutável (append-only com hash encadeado). */
async function auditarUpdate(
  tenantId: string,
  userId: string,
  maquinaId: string,
  versaoAnterior: string | null,
  tipo: "INDIVIDUAL" | "LOTE",
): Promise<void> {
  await comTenant(tenantId, (tdb) =>
    tdb.insert(logsServicosWindows).values({
      tenantId,
      usuarioId: userId,
      maquinaId,
      servicoNome: "NexusAgente",
      acaoExecutada: `UPDATE_AGENT_${tipo}:${versaoAnterior ?? "?"}→${config.AGENTE_VERSAO_PROD}`,
      statusResultado: "SINAL_ENVIADO",
    }),
  );
}

// ── Schema de validação ────────────────────────────────────────────────────

const UpdateLoteBody = z.object({
  grupoId: z.string().uuid().optional(),
  maquinaIds: z.array(z.string().uuid()).min(1).max(500).optional(),
});

// ── Plugin ─────────────────────────────────────────────────────────────────

export const agenteUpdateRoutes: FastifyPluginAsync = async (app) => {

  // GET /api/config/versao-agente — expõe a versão canônica de produção
  // Usado pelo frontend para comparar com a versão instalada em cada máquina.
  app.get(
    "/api/config/versao-agente",
    { preHandler: [app.requireAuth] },
    async (_req, reply) => {
      return reply.send({ versaoProd: config.AGENTE_VERSAO_PROD });
    },
  );

  // POST /api/maquinas/:id/atualizar — dispara update em uma máquina individual
  // Stack de segurança: auth + MFA + operador + escopo de tenant (anti-IDOR)
  app.post(
    "/api/maquinas/:id/atualizar",
    { preHandler: [app.requireAuth, app.requireMfa, app.requireOperador, requireEscopoMaquina] },
    async (req, reply) => {
      const { tenantId, userId } = req.auth!;
      const { id } = req.params as { id: string };

      const maq = await maquinaDoTenant(tenantId, id);
      if (!maq) return reply.code(404).send({ erro: "Máquina não encontrada" });
      if (!maq.online) return reply.code(409).send({ erro: "Máquina offline — não é possível enviar sinal de atualização" });

      // Verifica se já está na versão correta
      if (maq.versaoAgente === config.AGENTE_VERSAO_PROD) {
        return reply.code(409).send({ erro: "Agente já está na versão de produção", versao: config.AGENTE_VERSAO_PROD });
      }

      const socket = obterSocketAgente(id);
      if (!socket) return reply.code(409).send({ erro: "Socket do agente não encontrado — máquina pode ter acabado de desconectar" });

      // Marcar como em update (suprime alerta offline durante o restart)
      marcarEmUpdate(id);

      // Disparar sinal
      socket.emit(Ev.UpdateAvailable, {
        url: `${config.PUBLIC_URL}/agente/agent.js?t=${Date.now()}`,
        version: config.AGENTE_VERSAO_PROD,
      });

      // Auditoria
      await auditarUpdate(tenantId, userId, id, maq.versaoAgente, "INDIVIDUAL");

      app.log.info(
        { machineId: id, tenantId, userId, versaoAnterior: maq.versaoAgente, versaoAlvo: config.AGENTE_VERSAO_PROD },
        "Update manual de agente disparado",
      );

      return reply.send({ ok: true, versaoAlvo: config.AGENTE_VERSAO_PROD, hostname: maq.hostname });
    },
  );

  // POST /api/maquinas/atualizar-lote — dispara update em grupo ou lista de máquinas
  // Só envia para máquinas online e desatualizadas.
  app.post(
    "/api/maquinas/atualizar-lote",
    { preHandler: [app.requireAuth, app.requireMfa, app.requireOperador] },
    async (req, reply) => {
      const { tenantId, userId } = req.auth!;

      const parsed = UpdateLoteBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ erro: "Payload inválido", detalhes: parsed.error.flatten() });
      }

      const { grupoId, maquinaIds } = parsed.data;

      // Buscar máquinas online do tenant (filtradas por grupo ou lista explícita)
      const lista = await comTenant(tenantId, (tdb) => {
        if (maquinaIds && maquinaIds.length > 0) {
          // Lista explícita — ainda valida que todas pertencem ao tenant (anti-IDOR)
          return tdb
            .select({ id: maquinas.id, versaoAgente: maquinas.versaoAgente, online: maquinas.online })
            .from(maquinas)
            .where(and(eq(maquinas.tenantId, tenantId), eq(maquinas.online, true)));
        }
        if (grupoId) {
          return tdb
            .select({ id: maquinas.id, versaoAgente: maquinas.versaoAgente, online: maquinas.online })
            .from(maquinas)
            .where(and(eq(maquinas.tenantId, tenantId), eq(maquinas.grupoId, grupoId), eq(maquinas.online, true)));
        }
        // Sem filtro: todas as máquinas online do tenant
        return tdb
          .select({ id: maquinas.id, versaoAgente: maquinas.versaoAgente, online: maquinas.online })
          .from(maquinas)
          .where(and(eq(maquinas.tenantId, tenantId), eq(maquinas.online, true)));
      });

      // Se veio lista explícita, filtrar apenas os IDs solicitados (intersecção — anti-IDOR)
      const alvo = maquinaIds
        ? lista.filter((m) => maquinaIds.includes(m.id))
        : lista;

      let enviadas = 0;
      const ignoradas: string[] = [];

      for (const m of alvo) {
        // Pular máquinas já atualizadas
        if (m.versaoAgente === config.AGENTE_VERSAO_PROD) {
          ignoradas.push(m.id);
          continue;
        }

        const socket = obterSocketAgente(m.id);
        if (!socket) {
          ignoradas.push(m.id);
          continue;
        }

        marcarEmUpdate(m.id);
        socket.emit(Ev.UpdateAvailable, {
          url: `${config.PUBLIC_URL}/agente/agent.js?t=${Date.now()}`,
          version: config.AGENTE_VERSAO_PROD,
        });

        await auditarUpdate(tenantId, userId, m.id, m.versaoAgente, "LOTE");
        enviadas++;
      }

      app.log.info(
        { tenantId, userId, enviadas, ignoradas: ignoradas.length, versaoAlvo: config.AGENTE_VERSAO_PROD },
        "Update em lote de agentes disparado",
      );

      return reply.send({
        ok: true,
        enviadas,
        ignoradas: ignoradas.length,
        versaoAlvo: config.AGENTE_VERSAO_PROD,
      });
    },
  );
};
