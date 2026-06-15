import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { tenants, usuarios } from "../db/schema";
import { hashSenha } from "../auth/password";
import { redis } from "../redis";
import { emailReservado } from "../superadmin";
import { emailBoasVindas } from "../platform-email";

function slugify(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "cliente";
}

const Signup = z.object({
  empresa: z.string().min(2).max(120),
  email: z.string().email().max(160),
  senha: z.string().min(8).max(200),
});

export const signupRoutes: FastifyPluginAsync = async (app) => {
  // Auto-cadastro público — cria um tenant Trial + dono. Anti-abuso por IP + e-mail.
  app.post("/api/signup", async (req, reply) => {
    const ip = (req.headers["cf-connecting-ip"] as string) || req.ip || "?";
    // Limite: 3 contas por IP a cada 24h.
    const chave = `signup:ip:${ip}`;
    const n = Number(await redis.get(chave)) || 0;
    if (n >= 3) return reply.code(429).send({ erro: "Muitas contas criadas deste local. Tente mais tarde ou fale conosco." });

    const p = Signup.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ erro: "Preencha empresa, e-mail válido e senha (mín. 8)." });
    const email = p.data.email.toLowerCase();
    if (emailReservado(email)) return reply.code(400).send({ erro: "e-mail indisponível" });

    const jaExiste = (await db.select({ id: usuarios.id }).from(usuarios).where(eq(usuarios.email, email)).limit(1))[0];
    if (jaExiste) return reply.code(409).send({ erro: "Já existe uma conta com esse e-mail." });

    let slug = slugify(p.data.empresa);
    for (let i = 0; i < 50; i++) {
      const existe = (await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)).limit(1))[0];
      if (!existe) break;
      slug = slugify(p.data.empresa) + "-" + (i + 2);
    }
    try {
      const senhaHash = await hashSenha(p.data.senha);
      const trialExpiraEm = new Date(Date.now() + 7 * 86400000); // 7 dias
      await db.transaction(async (tx) => {
        const t = (await tx.insert(tenants).values({ nome: p.data.empresa, slug, plano: "trial", trialExpiraEm }).returning())[0]!;
        await tx.insert(usuarios).values({ tenantId: t.id, email, senhaHash, papel: "owner" });
      });
      await redis.incr(chave);
      await redis.expire(chave, 86400);
      void emailBoasVindas(email, p.data.empresa); // best-effort, não bloqueia
      return reply.send({ ok: true });
    } catch (err) {
      app.log.error({ err }, "Erro no signup");
      return reply.code(500).send({ erro: "erro ao criar conta" });
    }
  });
};
