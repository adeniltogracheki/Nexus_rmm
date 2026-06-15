import type { FastifyPluginAsync } from "fastify";
import { desc, eq, asc } from "drizzle-orm";
import { z } from "zod";
import { comTenant } from "../db/tenant";
import { chamados, chamadoComentarios, usuarios, maquinas } from "../db/schema";

const CriarChamado = z.object({
  titulo: z.string().min(1).max(200),
  descricao: z.string().min(1).max(5000),
  prioridade: z.enum(["baixa", "media", "alta", "critica"]).default("media"),
  maquinaId: z.string().uuid().nullable().optional(),
});
const AtualizarChamado = z.object({
  status: z.enum(["aberto", "em_andamento", "resolvido", "fechado"]).optional(),
  prioridade: z.enum(["baixa", "media", "alta", "critica"]).optional(),
  atribuidoA: z.string().uuid().nullable().optional(),
});
const Comentario = z.object({ texto: z.string().min(1).max(5000) });

export const chamadosRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/chamados", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { tenantId } = req.auth!;
    try {
      const dados = await comTenant(tenantId, async (tdb) => {
        const lista = await tdb.select().from(chamados).orderBy(desc(chamados.criadoEm)).limit(200);
        const us = await tdb.select({ id: usuarios.id, email: usuarios.email }).from(usuarios);
        const um = new Map(us.map((u) => [u.id, u.email]));
        const maq = await tdb
          .select({ id: maquinas.id, hostname: maquinas.hostname, apelido: maquinas.apelido })
          .from(maquinas);
        const maqMap = new Map(maq.map((m) => [m.id, m.apelido || m.hostname]));
        return lista.map((c) => ({
          ...c,
          abertoPorEmail: um.get(c.abertoPor) || "?",
          atribuidoAEmail: c.atribuidoA ? um.get(c.atribuidoA) || "?" : null,
          maquinaNome: c.maquinaId ? maqMap.get(c.maquinaId) || null : null,
        }));
      });
      return reply.send(dados);
    } catch (err) {
      app.log.error({ err, tenantId }, "Erro ao listar chamados");
      return reply.code(500).send({ erro: "erro ao listar chamados" });
    }
  });

  app.post("/api/chamados", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { tenantId, userId } = req.auth!;
    const p = CriarChamado.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ erro: "dados inválidos" });
    try {
      const novo = await comTenant(tenantId, async (tdb) => {
        const r = await tdb
          .insert(chamados)
          .values({
            tenantId,
            titulo: p.data.titulo,
            descricao: p.data.descricao,
            prioridade: p.data.prioridade,
            maquinaId: p.data.maquinaId ?? null,
            abertoPor: userId,
          })
          .returning();
        return r[0];
      });
      return reply.send(novo);
    } catch (err) {
      app.log.error({ err, tenantId }, "Erro ao criar chamado");
      return reply.code(500).send({ erro: "erro ao criar chamado" });
    }
  });

  app.get("/api/chamados/:id", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const { id } = req.params as { id: string };
    try {
      const dados = await comTenant(tenantId, async (tdb) => {
        const c = (await tdb.select().from(chamados).where(eq(chamados.id, id)).limit(1))[0];
        if (!c) return null;
        const us = await tdb.select({ id: usuarios.id, email: usuarios.email }).from(usuarios);
        const um = new Map(us.map((u) => [u.id, u.email]));
        const coms = await tdb
          .select()
          .from(chamadoComentarios)
          .where(eq(chamadoComentarios.chamadoId, id))
          .orderBy(asc(chamadoComentarios.criadoEm));
        return {
          chamado: {
            ...c,
            abertoPorEmail: um.get(c.abertoPor) || "?",
            atribuidoAEmail: c.atribuidoA ? um.get(c.atribuidoA) || "?" : null,
          },
          comentarios: coms.map((x) => ({ ...x, autorEmail: um.get(x.autorId) || "?" })),
          usuarios: us,
        };
      });
      if (!dados) return reply.code(404).send({ erro: "chamado não encontrado" });
      return reply.send(dados);
    } catch (err) {
      app.log.error({ err, tenantId, id }, "Erro ao obter chamado");
      return reply.code(500).send({ erro: "erro ao obter chamado" });
    }
  });

  app.patch("/api/chamados/:id", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const { id } = req.params as { id: string };
    const p = AtualizarChamado.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ erro: "dados inválidos" });
    const upd: Record<string, unknown> = { atualizadoEm: new Date() };
    if (p.data.status !== undefined) upd.status = p.data.status;
    if (p.data.prioridade !== undefined) upd.prioridade = p.data.prioridade;
    if (p.data.atribuidoA !== undefined) upd.atribuidoA = p.data.atribuidoA;
    try {
      await comTenant(tenantId, async (tdb) => {
        await tdb.update(chamados).set(upd).where(eq(chamados.id, id));
      });
      return reply.send({ ok: true });
    } catch (err) {
      app.log.error({ err, tenantId, id }, "Erro ao atualizar chamado");
      return reply.code(500).send({ erro: "erro ao atualizar chamado" });
    }
  });

  app.post("/api/chamados/:id/comentarios", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { tenantId, userId } = req.auth!;
    const { id } = req.params as { id: string };
    const p = Comentario.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ erro: "texto inválido" });
    try {
      await comTenant(tenantId, async (tdb) => {
        await tdb.insert(chamadoComentarios).values({ tenantId, chamadoId: id, autorId: userId, texto: p.data.texto });
        await tdb.update(chamados).set({ atualizadoEm: new Date() }).where(eq(chamados.id, id));
      });
      return reply.send({ ok: true });
    } catch (err) {
      app.log.error({ err, tenantId, id }, "Erro ao comentar no chamado");
      return reply.code(500).send({ erro: "erro ao comentar" });
    }
  });
};
