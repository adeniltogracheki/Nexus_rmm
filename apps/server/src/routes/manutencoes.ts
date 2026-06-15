import type { FastifyPluginAsync } from "fastify";
import { eq, and, desc, isNotNull, inArray } from "drizzle-orm";
import { z } from "zod";
import { comTenant } from "../db/tenant";
import { manutencoes, manutencaoAnexos, maquinas } from "../db/schema";
import { requireEscopoMaquina } from "../escopo";
import { requirePlano } from "../plano-guard";

// Extrai valor numérico de um custo livre (ex.: "R$ 1.234,56", "480", "480,00").
function parseCusto(s: string | null | undefined): number {
  if (!s) return 0;
  let t = String(s).replace(/[^\d.,]/g, "");
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", "."); // BR: . milhar, , decimal
  const n = parseFloat(t);
  return isNaN(n) ? 0 : n;
}

const CriarManut = z.object({
  tipo: z.enum(["preventiva", "corretiva", "melhoria", "instalacao"]).default("corretiva"),
  descricao: z.string().min(1).max(4000),
  pecasTrocadas: z.string().max(2000).nullable().optional(),
  tecnico: z.string().max(200).nullable().optional(),
  custo: z.string().max(60).nullable().optional(),
  statusManut: z.enum(["aberta", "em_andamento", "concluida"]).default("concluida"),
  dataManutencao: z.string().datetime().optional(),
  proximaPreventiva: z.string().datetime().nullable().optional(),
});

export const manutencoesRoutes: FastifyPluginAsync = async (app) => {
  // Lista as manutenções de uma máquina.
  app.get("/api/maquinas/:id/manutencoes", { preHandler: [app.requireAuth, requirePlano("manutencao"), requireEscopoMaquina] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.auth!;
    const dados = await comTenant(tenantId, async (tdb) => {
      const lista = await tdb.select().from(manutencoes).where(eq(manutencoes.maquinaId, id)).orderBy(desc(manutencoes.dataManutencao));
      if (lista.length === 0) return [];
      const ids = lista.map((m) => m.id);
      const anexos = await tdb
        .select({ id: manutencaoAnexos.id, manutencaoId: manutencaoAnexos.manutencaoId, nome: manutencaoAnexos.nome, tipo: manutencaoAnexos.tipo, tamanho: manutencaoAnexos.tamanho })
        .from(manutencaoAnexos)
        .where(inArray(manutencaoAnexos.manutencaoId, ids));
      return lista.map((m) => ({ ...m, anexos: anexos.filter((a) => a.manutencaoId === m.id) }));
    });
    return reply.send(dados);
  });

  // Anexa um arquivo (foto/nota fiscal) a uma manutenção. Base64, até 6MB.
  app.post("/api/manutencoes/:mid/anexos", { preHandler: [app.requireAuth, app.requireMfa] }, async (req, reply) => {
    const { mid } = req.params as { mid: string };
    const { tenantId } = req.auth!;
    const p = z.object({ nome: z.string().min(1).max(255), tipo: z.string().min(1).max(120), dados: z.string().min(1) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ erro: "dados inválidos" });
    const bytes = Math.floor((p.data.dados.length * 3) / 4);
    if (bytes > 6 * 1024 * 1024) return reply.code(413).send({ erro: "arquivo grande demais (máx 6MB)" });
    const novo = await comTenant(tenantId, async (tdb) => {
      // garante que a manutenção é do tenant
      const m = (await tdb.select({ id: manutencoes.id }).from(manutencoes).where(and(eq(manutencoes.id, mid), eq(manutencoes.tenantId, tenantId))).limit(1))[0];
      if (!m) return null;
      const r = await tdb.insert(manutencaoAnexos).values({ tenantId, manutencaoId: mid, nome: p.data.nome, tipo: p.data.tipo, tamanho: bytes, dados: p.data.dados }).returning({ id: manutencaoAnexos.id });
      return r[0];
    });
    if (!novo) return reply.code(404).send({ erro: "manutenção não encontrada" });
    return reply.send({ ok: true, id: novo.id });
  });

  // Serve um anexo (imagem inline / download).
  app.get("/api/manutencoes/anexo/:aid", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { aid } = req.params as { aid: string };
    const { tenantId } = req.auth!;
    const a = await comTenant(tenantId, (tdb) => tdb.select().from(manutencaoAnexos).where(and(eq(manutencaoAnexos.id, aid), eq(manutencaoAnexos.tenantId, tenantId))).limit(1));
    if (!a[0]) return reply.code(404).send({ erro: "não encontrado" });
    const buf = Buffer.from(a[0].dados, "base64");
    reply.header("Content-Disposition", `inline; filename="${a[0].nome.replace(/"/g, "")}"`);
    reply.type(a[0].tipo || "application/octet-stream");
    return reply.send(buf);
  });

  app.delete("/api/manutencoes/anexo/:aid", { preHandler: [app.requireAuth, app.requireMfa] }, async (req, reply) => {
    const { aid } = req.params as { aid: string };
    const { tenantId } = req.auth!;
    await comTenant(tenantId, (tdb) => tdb.delete(manutencaoAnexos).where(and(eq(manutencaoAnexos.id, aid), eq(manutencaoAnexos.tenantId, tenantId))));
    return reply.send({ ok: true });
  });

  // Registra uma manutenção.
  app.post("/api/maquinas/:id/manutencoes", { preHandler: [app.requireAuth, app.requireMfa, requirePlano("manutencao"), requireEscopoMaquina] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.auth!;
    const p = CriarManut.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ erro: "dados inválidos" });
    const novo = await comTenant(tenantId, async (tdb) => {
      const r = await tdb.insert(manutencoes).values({
        tenantId, maquinaId: id,
        tipo: p.data.tipo,
        descricao: p.data.descricao,
        pecasTrocadas: p.data.pecasTrocadas ?? null,
        tecnico: p.data.tecnico ?? null,
        custo: p.data.custo ?? null,
        statusManut: p.data.statusManut,
        dataManutencao: p.data.dataManutencao ? new Date(p.data.dataManutencao) : new Date(),
        proximaPreventiva: p.data.proximaPreventiva ? new Date(p.data.proximaPreventiva) : null,
      }).returning();
      return r[0];
    });
    return reply.send(novo);
  });

  // Remove um registro de manutenção.
  app.delete("/api/manutencoes/:mid", { preHandler: [app.requireAuth, app.requireMfa] }, async (req, reply) => {
    const { mid } = req.params as { mid: string };
    const { tenantId } = req.auth!;
    await comTenant(tenantId, (tdb) => tdb.delete(manutencoes).where(and(eq(manutencoes.id, mid), eq(manutencoes.tenantId, tenantId))));
    return reply.send({ ok: true });
  });

  // Define o responsável pela máquina.
  app.patch("/api/maquinas/:id/responsavel", { preHandler: [app.requireAuth, app.requireMfa, requirePlano("manutencao"), requireEscopoMaquina] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.auth!;
    const p = z.object({ responsavel: z.string().max(200).nullable() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ erro: "dados inválidos" });
    await comTenant(tenantId, (tdb) => tdb.update(maquinas).set({ responsavel: p.data.responsavel }).where(eq(maquinas.id, id)));
    return reply.send({ ok: true });
  });

  // Relatório de manutenções: próximas preventivas + recentes.
  app.get("/api/relatorios/manutencoes", { preHandler: [app.requireAuth, requirePlano("manutencao")] }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const dados = await comTenant(tenantId, async (tdb) => {
      const recentes = await tdb
        .select({
          id: manutencoes.id, maquinaId: manutencoes.maquinaId, hostname: maquinas.hostname, apelido: maquinas.apelido,
          tipo: manutencoes.tipo, descricao: manutencoes.descricao, pecas: manutencoes.pecasTrocadas, tecnico: manutencoes.tecnico,
          custo: manutencoes.custo, status: manutencoes.statusManut, data: manutencoes.dataManutencao, proxima: manutencoes.proximaPreventiva,
        })
        .from(manutencoes)
        .leftJoin(maquinas, eq(manutencoes.maquinaId, maquinas.id))
        .orderBy(desc(manutencoes.dataManutencao))
        .limit(200);
      const preventivas = await tdb
        .select({
          id: manutencoes.id, maquinaId: manutencoes.maquinaId, hostname: maquinas.hostname, apelido: maquinas.apelido,
          proxima: manutencoes.proximaPreventiva, descricao: manutencoes.descricao,
        })
        .from(manutencoes)
        .leftJoin(maquinas, eq(manutencoes.maquinaId, maquinas.id))
        .where(isNotNull(manutencoes.proximaPreventiva))
        .orderBy(manutencoes.proximaPreventiva);
      // Custo acumulado por máquina (e total).
      const todos = await tdb
        .select({ maquinaId: manutencoes.maquinaId, hostname: maquinas.hostname, apelido: maquinas.apelido, grupoId: maquinas.grupoId, custo: manutencoes.custo })
        .from(manutencoes)
        .leftJoin(maquinas, eq(manutencoes.maquinaId, maquinas.id));
      const porMaq = new Map<string, { maquinaId: string; nome: string; grupoId: string | null; total: number; qtd: number }>();
      let custoTotal = 0;
      for (const t of todos) {
        const v = parseCusto(t.custo);
        custoTotal += v;
        const cur = porMaq.get(t.maquinaId) || { maquinaId: t.maquinaId, nome: t.apelido || t.hostname || "—", grupoId: t.grupoId, total: 0, qtd: 0 };
        cur.total += v; cur.qtd += 1;
        porMaq.set(t.maquinaId, cur);
      }
      return { recentes, preventivas, custoTotal, custos: [...porMaq.values()].sort((a, b) => b.total - a.total) };
    });
    return reply.send(dados);
  });
};
