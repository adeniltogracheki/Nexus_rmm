import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { tenants } from "./db/schema";
import { config } from "./config";

/**
 * Super admin da plataforma = e-mail configurado E pertencente ao tenant raiz
 * (slug SEED_TENANT_SLUG). Amarrar ao tenant evita que um cliente crie um usuário
 * com o mesmo e-mail no tenant dele e escale privilégio.
 */
export async function ehSuperAdmin(claims?: { email?: string; tenantId?: string } | null): Promise<boolean> {
  if (!claims?.email || !claims.tenantId) return false;
  if (claims.email.toLowerCase() !== config.PLATFORM_ADMIN_EMAIL.toLowerCase()) return false;
  const t = (await db.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, claims.tenantId)).limit(1))[0];
  return !!t && t.slug === config.SEED_TENANT_SLUG;
}

export async function requireSuperAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!(await ehSuperAdmin(req.auth))) {
    reply.code(403).send({ erro: "apenas o super admin da plataforma" });
  }
}

/** E-mail reservado da plataforma — não pode ser usado em outros tenants. */
export function emailReservado(email: string): boolean {
  return email.toLowerCase() === config.PLATFORM_ADMIN_EMAIL.toLowerCase();
}
