import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { comTenant } from "../db/tenant";
import { grupos, maquinas } from "../db/schema";
import { temRestricao, mapaEmpresaRaiz } from "../escopo";

const CriarGrupo = z.object({
  nome: z.string().min(1).max(120),
  tipo: z.enum(["empresa", "departamento"]).default("empresa"),
  parentId: z.string().uuid().optional(),
});

const AtribuirMaquina = z.object({
  grupoId: z.string().uuid().nullable().optional(),
  tipoMaquina: z.enum(["pc", "servidor"]).optional(),
  apelido: z.string().max(120).nullable().optional(),
  tags: z.array(z.string().max(40)).max(30).optional(),
});

export const gruposRoutes: FastifyPluginAsync = async (app) => {
  // Lista plana de grupos do tenant (a árvore é montada no front).
  app.get("/api/grupos", { preHandler: [app.requireAuth] }, async (req, reply) => {
    let lista = await comTenant(req.auth!.tenantId, (tdb) => tdb.select().from(grupos));
    // Escopo por empresa: usuário restrito só vê as empresas dele (e seus departamentos).
    if (temRestricao(req.auth)) {
      const raiz = await mapaEmpresaRaiz(req.auth!.tenantId);
      const permitidas = new Set(req.auth!.empresas as string[]);
      lista = lista.filter((g) => permitidas.has(raiz.get(g.id) || ""));
    }
    return reply.send(lista);
  });

  // Cria empresa (topo) ou departamento (precisa de parentId = empresa).
  app.post("/api/grupos", { preHandler: [app.requireAuth, app.requireMfa] }, async (req, reply) => {
    const parsed = CriarGrupo.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ erro: "dados inválidos" });
    const { nome, tipo, parentId } = parsed.data;
    if (tipo === "departamento" && !parentId) {
      return reply.code(400).send({ erro: "departamento precisa de uma empresa (parentId)" });
    }
    const tenantId = req.auth!.tenantId;

    const resultado = await comTenant(tenantId, async (tdb) => {
      if (parentId) {
        const pai = (await tdb.select().from(grupos).where(eq(grupos.id, parentId)).limit(1))[0];
        if (!pai) return { erro: "empresa (parent) não encontrada" as const };
      }
      const novo = (
        await tdb.insert(grupos).values({ tenantId, nome, tipo, parentId: parentId ?? null }).returning()
      )[0];
      return { grupo: novo };
    });

    if ("erro" in resultado) return reply.code(404).send(resultado);
    return reply.code(201).send(resultado.grupo);
  });

  // Atribui uma máquina a um grupo e/ou define o tipo (PC/servidor).
  app.post(
    "/api/maquinas/:id/grupo",
    { preHandler: [app.requireAuth, app.requireMfa] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = AtribuirMaquina.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ erro: "dados inválidos" });

      const upd: Partial<{ grupoId: string | null; tipoMaquina: "pc" | "servidor"; apelido: string | null; tags: string[] }> = {};
      if (parsed.data.grupoId !== undefined) upd.grupoId = parsed.data.grupoId;
      if (parsed.data.tipoMaquina) upd.tipoMaquina = parsed.data.tipoMaquina;
      if (parsed.data.apelido !== undefined) {
        const a = parsed.data.apelido?.trim();
        upd.apelido = a ? a : null;
      }
      if (parsed.data.tags !== undefined) {
        upd.tags = parsed.data.tags.map((t) => t.trim()).filter(Boolean).slice(0, 30);
      }
      if (Object.keys(upd).length === 0) return reply.code(400).send({ erro: "nada para atualizar" });

      const tenantId = req.auth!.tenantId;
      const ok = await comTenant(tenantId, async (tdb) => {
        const m = (await tdb.select().from(maquinas).where(eq(maquinas.id, id)).limit(1))[0];
        if (!m) return false;
        // valida grupo (se informado e não-nulo) no mesmo tenant
        if (upd.grupoId) {
          const g = (await tdb.select().from(grupos).where(eq(grupos.id, upd.grupoId)).limit(1))[0];
          if (!g) return false;
        }
        await tdb.update(maquinas).set(upd).where(eq(maquinas.id, id));
        return true;
      });
      if (!ok) return reply.code(404).send({ erro: "máquina ou grupo não encontrado" });
      return reply.send({ ok: true });
    },
  );

  // Exclui um grupo (subgrupos e máquinas ficam sem pai via FK ON DELETE SET NULL).
  app.delete("/api/grupos/:id", { preHandler: [app.requireAuth, app.requireMfa] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await comTenant(req.auth!.tenantId, async (tdb) => {
      const g = (await tdb.select().from(grupos).where(eq(grupos.id, id)).limit(1))[0];
      if (!g) return false;
      await tdb.delete(grupos).where(eq(grupos.id, id));
      return true;
    });
    if (!ok) return reply.code(404).send({ erro: "grupo não encontrado" });
    return reply.send({ ok: true });
  });
};
