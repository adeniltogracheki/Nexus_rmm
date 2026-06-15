import type { FastifyPluginAsync } from "fastify";
import { and, eq, desc } from "drizzle-orm";
import { z } from "zod";
import { comTenant } from "../db/tenant";
import { tarefasAgendadas, maquinas } from "../db/schema";

const CriarTarefa = z.object({
  maquinaId: z.string().uuid(),
  nome: z.string().min(1).max(120),
  comando: z.string().min(1).max(8000),
  shell: z.enum(["powershell", "cmd"]).default("powershell"),
  frequencia: z.enum(["diaria", "unica"]).default("diaria"),
  horario: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  dataUnica: z.string().optional(),
});

function proximoHorarioDiario(horario: string | undefined, base: Date): Date {
  const [h, m] = (horario || "03:00").split(":").map((x) => Number(x));
  const d = new Date(base);
  d.setHours(h || 0, m || 0, 0, 0);
  if (d <= base) d.setDate(d.getDate() + 1);
  return d;
}

export const tarefasRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/tarefas", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { tenantId } = req.auth!;
    try {
      const dados = await comTenant(tenantId, async (tdb) => {
        const lista = await tdb
          .select()
          .from(tarefasAgendadas)
          .where(eq(tarefasAgendadas.tenantId, tenantId))
          .orderBy(desc(tarefasAgendadas.criadoEm))
          .limit(200);
        const maq = await tdb.select({ id: maquinas.id, hostname: maquinas.hostname, apelido: maquinas.apelido }).from(maquinas);
        const maqMap = new Map(maq.map((m) => [m.id, m.apelido || m.hostname]));
        return lista.map((t) => ({ ...t, maquinaNome: maqMap.get(t.maquinaId) || "?" }));
      });
      return reply.send(dados);
    } catch (err) {
      app.log.error({ err, tenantId }, "Erro ao listar tarefas");
      return reply.code(500).send({ erro: "erro ao listar tarefas" });
    }
  });

  app.post("/api/tarefas", { preHandler: [app.requireAuth, app.requireMfa, app.requireOperador] }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const p = CriarTarefa.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ erro: "dados inválidos" });
    const agora = new Date();
    let proximaExec: Date;
    if (p.data.frequencia === "diaria") {
      proximaExec = proximoHorarioDiario(p.data.horario, agora);
    } else {
      const d = p.data.dataUnica ? new Date(p.data.dataUnica) : agora;
      proximaExec = isNaN(d.getTime()) || d <= agora ? new Date(agora.getTime() + 60_000) : d;
    }
    try {
      // valida que a máquina é do tenant
      const ok = await comTenant(tenantId, async (tdb) => {
        const r = await tdb.select({ id: maquinas.id }).from(maquinas).where(eq(maquinas.id, p.data.maquinaId)).limit(1);
        return r.length > 0;
      });
      if (!ok) return reply.code(404).send({ erro: "máquina não encontrada" });
      const novo = await comTenant(tenantId, async (tdb) => {
        const r = await tdb
          .insert(tarefasAgendadas)
          .values({
            tenantId,
            maquinaId: p.data.maquinaId,
            nome: p.data.nome,
            comando: p.data.comando,
            shell: p.data.shell,
            frequencia: p.data.frequencia,
            horario: p.data.frequencia === "diaria" ? p.data.horario || "03:00" : null,
            dataUnica: p.data.frequencia === "unica" ? proximaExec : null,
            proximaExec,
          })
          .returning();
        return r[0];
      });
      return reply.send(novo);
    } catch (err) {
      app.log.error({ err, tenantId }, "Erro ao criar tarefa");
      return reply.code(500).send({ erro: "erro ao criar tarefa" });
    }
  });

  app.patch("/api/tarefas/:id", { preHandler: [app.requireAuth, app.requireOperador] }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const { id } = req.params as { id: string };
    const ativo = (req.body as { ativo?: boolean })?.ativo;
    if (typeof ativo !== "boolean") return reply.code(400).send({ erro: "dados inválidos" });
    try {
      await comTenant(tenantId, (tdb) =>
        tdb.update(tarefasAgendadas).set({ ativo }).where(and(eq(tarefasAgendadas.id, id), eq(tarefasAgendadas.tenantId, tenantId))),
      );
      return reply.send({ ok: true });
    } catch (err) {
      app.log.error({ err, tenantId, id }, "Erro ao atualizar tarefa");
      return reply.code(500).send({ erro: "erro ao atualizar tarefa" });
    }
  });

  app.delete("/api/tarefas/:id", { preHandler: [app.requireAuth, app.requireMfa, app.requireOperador] }, async (req, reply) => {
    const { tenantId } = req.auth!;
    const { id } = req.params as { id: string };
    try {
      await comTenant(tenantId, (tdb) =>
        tdb.delete(tarefasAgendadas).where(and(eq(tarefasAgendadas.id, id), eq(tarefasAgendadas.tenantId, tenantId))),
      );
      return reply.send({ ok: true });
    } catch (err) {
      app.log.error({ err, tenantId, id }, "Erro ao excluir tarefa");
      return reply.code(500).send({ erro: "erro ao excluir tarefa" });
    }
  });
};
