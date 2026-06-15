import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getConfigSeguranca, salvarConfigSeguranca } from "../seguranca";

const podeGerir = (papel?: string) => papel === "owner" || papel === "admin";

export const segurancaRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/seguranca", { preHandler: [app.requireAuth] }, async (req, reply) => {
    if (!podeGerir(req.auth!.papel)) return reply.code(403).send({ erro: "sem permissão" });
    return reply.send(getConfigSeguranca());
  });

  app.put("/api/seguranca", { preHandler: [app.requireAuth, app.requireMfa] }, async (req, reply) => {
    if (!podeGerir(req.auth!.papel)) return reply.code(403).send({ erro: "sem permissão" });
    const p = z.object({ apenasBrasil: z.boolean().optional(), forcar2fa: z.boolean().optional(), nomeMarca: z.string().max(80).optional(), logoUrl: z.string().max(2000).optional() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ erro: "dados inválidos" });
    await salvarConfigSeguranca(p.data);
    return reply.send({ ok: true, ...getConfigSeguranca() });
  });
};
