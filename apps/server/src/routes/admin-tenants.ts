import type { FastifyPluginAsync } from "fastify";
import { eq, sql, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { tenants, usuarios, maquinas } from "../db/schema";
import { comTenant } from "../db/tenant";
import { hashSenha } from "../auth/password";
import { requireSuperAdmin, emailReservado } from "../superadmin";
import { planoDe } from "../planos";

function slugify(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "cliente";
}

const CriarTenant = z.object({
  nome: z.string().min(2).max(120),
  plano: z.enum(["trial", "essencial", "pro", "enterprise"]).default("trial"),
  ownerEmail: z.string().email(),
  ownerSenha: z.string().min(8).max(200),
});

export const adminTenantsRoutes: FastifyPluginAsync = async (app) => {
  // Lista todas as contas (tenants) da plataforma.
  app.get("/api/admin/tenants", { preHandler: [app.requireAuth, requireSuperAdmin] }, async (_req, reply) => {
    const ts = await db.select().from(tenants);
    // usuarios não tem RLS → global db ok.
    const owners = await db.select({ tenantId: usuarios.tenantId, email: usuarios.email }).from(usuarios).where(eq(usuarios.papel, "owner"));
    const oe = new Map(owners.map((o) => [o.tenantId, o.email]));
    // maquinas tem RLS → conta por tenant com o contexto correto (comTenant).
    const out = [];
    for (const t of ts) {
      let nmaq = 0, nonline = 0;
      try {
        const c = await comTenant(t.id, (tdb) =>
          tdb.select({ total: sql<number>`count(*)::int`, online: sql<number>`count(*) filter (where ${maquinas.online})::int` }).from(maquinas).where(eq(maquinas.arquivada, false)),
        );
        nmaq = c[0]?.total || 0;
        nonline = c[0]?.online || 0;
      } catch { nmaq = 0; nonline = 0; }
      out.push({ id: t.id, nome: t.nome, slug: t.slug, plano: t.plano, ativo: t.ativo, criadoEm: t.criadoEm, maquinas: nmaq, online: nonline, owner: oe.get(t.id) || null });
    }
    // Resumo da plataforma.
    let mrr = 0, pagantes = 0, trials = 0;
    for (const t of out) {
      if (!t.ativo) continue;
      const preco = planoDe(t.plano).precoMes || 0;
      if (t.plano === "trial") trials++;
      if (preco > 0) { mrr += preco; pagantes++; }
    }
    const resumo = {
      tenants: out.length,
      tenantsAtivos: out.filter((t) => t.ativo).length,
      tenantsComMaquinaOnline: out.filter((t) => t.online > 0).length,
      maquinas: out.reduce((s, t) => s + t.maquinas, 0),
      maquinasOnline: out.reduce((s, t) => s + t.online, 0),
      mrr, pagantes, trials,
    };
    return reply.send({ resumo, contas: out });
  });

  // Cria uma conta de cliente: tenant novo + usuário owner.
  app.post("/api/admin/tenants", { preHandler: [app.requireAuth, app.requireMfa, requireSuperAdmin] }, async (req, reply) => {
    const p = CriarTenant.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ erro: "dados inválidos (senha mín. 8)" });
    const email = p.data.ownerEmail.toLowerCase();
    if (emailReservado(email)) return reply.code(400).send({ erro: "e-mail reservado da plataforma" });
    // E-mail já existe?
    const jaExiste = (await db.select({ id: usuarios.id }).from(usuarios).where(eq(usuarios.email, email)).limit(1))[0];
    if (jaExiste) return reply.code(409).send({ erro: "já existe um usuário com esse e-mail" });

    let slug = slugify(p.data.nome);
    // garante slug único
    for (let i = 0; i < 50; i++) {
      const existe = (await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)).limit(1))[0];
      if (!existe) break;
      slug = slugify(p.data.nome) + "-" + (i + 2);
    }
    try {
      const senhaHash = await hashSenha(p.data.ownerSenha);
      const trialExpiraEm = p.data.plano === "trial" ? new Date(Date.now() + 7 * 86400000) : null;
      const novo = await db.transaction(async (tx) => {
        const t = (await tx.insert(tenants).values({ nome: p.data.nome, slug, plano: p.data.plano, trialExpiraEm }).returning())[0]!;
        await tx.insert(usuarios).values({ tenantId: t.id, email, senhaHash, papel: "owner" });
        return t;
      });
      return reply.send({ ok: true, id: novo.id, slug: novo.slug, owner: email });
    } catch (err) {
      app.log.error({ err }, "Erro ao criar tenant");
      return reply.code(500).send({ erro: "erro ao criar conta" });
    }
  });

  // Altera plano/ativo de um tenant.
  app.put("/api/admin/tenants/:id", { preHandler: [app.requireAuth, app.requireMfa, requireSuperAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = z.object({ plano: z.enum(["trial", "essencial", "pro", "enterprise"]).optional(), ativo: z.boolean().optional() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ erro: "dados inválidos" });
    const upd: Record<string, unknown> = {};
    if (p.data.plano !== undefined) upd.plano = p.data.plano;
    if (p.data.ativo !== undefined) upd.ativo = p.data.ativo;
    if (Object.keys(upd).length) await db.update(tenants).set(upd).where(eq(tenants.id, id));
    return reply.send({ ok: true });
  });

  // Recuperação do dono de um tenant (super admin): reseta MFA do owner.
  app.post("/api/admin/tenants/:id/reset-mfa", { preHandler: [app.requireAuth, app.requireMfa, requireSuperAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.update(usuarios).set({ mfaSecret: null, mfaPendente: null }).where(and(eq(usuarios.tenantId, id), eq(usuarios.papel, "owner")));
    return reply.send({ ok: true });
  });

  // Recuperação do dono de um tenant (super admin): define nova senha do owner.
  app.post("/api/admin/tenants/:id/reset-senha", { preHandler: [app.requireAuth, app.requireMfa, requireSuperAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = z.object({ senha: z.string().min(8).max(200) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ erro: "senha mín. 8 caracteres" });
    const hash = await hashSenha(p.data.senha);
    await db.update(usuarios).set({ senhaHash: hash }).where(and(eq(usuarios.tenantId, id), eq(usuarios.papel, "owner")));
    return reply.send({ ok: true });
  });
};
