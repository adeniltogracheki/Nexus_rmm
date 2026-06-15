import type { FastifyPluginAsync } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { comTenant } from "../db/tenant";
import { usuarios } from "../db/schema";
import { hashSenha } from "../auth/password";
import { permissoesEfetivas } from "../permissoes";
import { emailReservado } from "../superadmin";

// Só owner/admin gerenciam usuários.
const podeGerir = (papel?: string) => papel === "owner" || papel === "admin";

const CriarUsuario = z.object({
  email: z.string().email(),
  senha: z.string().min(8).max(200),
  papel: z.enum(["admin", "operator", "viewer", "cliente"]).default("operator"),
  empresasPermitidas: z.array(z.string().uuid()).max(200).nullable().optional(),
  permissoes: z.array(z.string().max(40)).max(50).nullable().optional(),
});
const AtualizarUsuario = z.object({
  papel: z.enum(["admin", "operator", "viewer", "cliente"]).optional(),
  ativo: z.boolean().optional(),
  senha: z.string().min(8).max(200).optional(),
  empresasPermitidas: z.array(z.string().uuid()).max(200).nullable().optional(),
  permissoes: z.array(z.string().max(40)).max(50).nullable().optional(),
  resetarMfa: z.boolean().optional(),
});

export const usuariosRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/usuarios — lista usuários do tenant (filtro explícito; usuarios não tem RLS).
  app.get("/api/usuarios", { preHandler: [app.requireAuth] }, async (req, reply) => {
    if (!podeGerir(req.auth!.papel)) return reply.code(403).send({ erro: "sem permissão" });
    const { tenantId } = req.auth!;
    try {
      const lista = await comTenant(tenantId, (tdb) =>
        tdb
          .select({
            id: usuarios.id,
            email: usuarios.email,
            papel: usuarios.papel,
            ativo: usuarios.ativo,
            ultimoLogin: usuarios.ultimoLogin,
            mfaSecret: usuarios.mfaSecret,
            empresasPermitidas: usuarios.empresasPermitidas,
            permissoes: usuarios.permissoes,
          })
          .from(usuarios)
          .where(eq(usuarios.tenantId, tenantId)),
      );
      return reply.send(
        lista.map((u) => ({
          id: u.id,
          email: u.email,
          papel: u.papel,
          ativo: u.ativo,
          ultimoLogin: u.ultimoLogin,
          mfaAtivo: !!u.mfaSecret,
          empresasPermitidas: u.empresasPermitidas ?? null,
          permissoes: u.permissoes ?? null,
          permissoesEfetivas: permissoesEfetivas(u.papel, u.permissoes as string[] | null),
        })),
      );
    } catch (err) {
      app.log.error({ err, tenantId }, "Erro ao listar usuários");
      return reply.code(500).send({ erro: "erro ao listar usuários" });
    }
  });

  // POST /api/usuarios — cria usuário (exige MFA do admin).
  app.post("/api/usuarios", { preHandler: [app.requireAuth, app.requireMfa] }, async (req, reply) => {
    if (!podeGerir(req.auth!.papel)) return reply.code(403).send({ erro: "sem permissão" });
    const { tenantId } = req.auth!;
    const p = CriarUsuario.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ erro: "dados inválidos (senha mín. 8 caracteres)" });
    if (emailReservado(p.data.email)) return reply.code(400).send({ erro: "e-mail reservado da plataforma" });
    try {
      const senhaHash = await hashSenha(p.data.senha);
      const novo = await comTenant(tenantId, async (tdb) => {
        const r = await tdb
          .insert(usuarios)
          .values({ tenantId, email: p.data.email.toLowerCase(), senhaHash, papel: p.data.papel, empresasPermitidas: p.data.empresasPermitidas ?? null, permissoes: p.data.permissoes ?? null })
          .returning({ id: usuarios.id, email: usuarios.email, papel: usuarios.papel });
        return r[0];
      });
      return reply.send(novo);
    } catch (err: any) {
      if (err?.code === "23505" || String(err?.message || "").includes("uq_usuarios_tenant_email")) {
        return reply.code(409).send({ erro: "já existe um usuário com esse email" });
      }
      app.log.error({ err, tenantId }, "Erro ao criar usuário");
      return reply.code(500).send({ erro: "erro ao criar usuário" });
    }
  });

  // PATCH /api/usuarios/:id — muda papel/ativo/senha (exige MFA).
  app.patch("/api/usuarios/:id", { preHandler: [app.requireAuth, app.requireMfa] }, async (req, reply) => {
    if (!podeGerir(req.auth!.papel)) return reply.code(403).send({ erro: "sem permissão" });
    const { tenantId, userId } = req.auth!;
    const { id } = req.params as { id: string };
    const p = AtualizarUsuario.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ erro: "dados inválidos" });
    if (id === userId && p.data.ativo === false) {
      return reply.code(400).send({ erro: "você não pode desativar a si mesmo" });
    }
    const upd: Record<string, unknown> = {};
    if (p.data.papel !== undefined) upd.papel = p.data.papel;
    if (p.data.ativo !== undefined) upd.ativo = p.data.ativo;
    if (p.data.senha !== undefined) upd.senhaHash = await hashSenha(p.data.senha);
    if (p.data.empresasPermitidas !== undefined) upd.empresasPermitidas = p.data.empresasPermitidas;
    if (p.data.permissoes !== undefined) upd.permissoes = p.data.permissoes;
    if (p.data.resetarMfa) { upd.mfaSecret = null; upd.mfaPendente = null; } // limpa o MFA — configura de novo no próximo login
    if (Object.keys(upd).length === 0) return reply.send({ ok: true });
    try {
      await comTenant(tenantId, (tdb) =>
        tdb.update(usuarios).set(upd).where(and(eq(usuarios.id, id), eq(usuarios.tenantId, tenantId))),
      );
      return reply.send({ ok: true });
    } catch (err) {
      app.log.error({ err, tenantId, id }, "Erro ao atualizar usuário");
      return reply.code(500).send({ erro: "erro ao atualizar usuário" });
    }
  });

  // DELETE /api/usuarios/:id — exclui um usuário (exige MFA). Não exclui você mesmo nem o dono.
  app.delete("/api/usuarios/:id", { preHandler: [app.requireAuth, app.requireMfa] }, async (req, reply) => {
    if (!podeGerir(req.auth!.papel)) return reply.code(403).send({ erro: "sem permissão" });
    const { tenantId, userId } = req.auth!;
    const { id } = req.params as { id: string };
    if (id === userId) return reply.code(400).send({ erro: "você não pode excluir a si mesmo" });
    const alvo = (await comTenant(tenantId, (tdb) =>
      tdb.select({ papel: usuarios.papel }).from(usuarios).where(and(eq(usuarios.id, id), eq(usuarios.tenantId, tenantId))).limit(1),
    ))[0];
    if (!alvo) return reply.code(404).send({ erro: "usuário não encontrado" });
    if (alvo.papel === "owner") return reply.code(400).send({ erro: "não é possível excluir o dono da conta" });
    try {
      await comTenant(tenantId, (tdb) => tdb.delete(usuarios).where(and(eq(usuarios.id, id), eq(usuarios.tenantId, tenantId))));
      return reply.send({ ok: true });
    } catch (err) {
      app.log.error({ err, tenantId, id }, "Erro ao excluir usuário");
      return reply.code(500).send({ erro: "erro ao excluir usuário" });
    }
  });
};
