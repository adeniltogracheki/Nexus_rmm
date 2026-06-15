import fp from "fastify-plugin";
import cookie from "@fastify/cookie";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { lerAccess, type AccessClaims } from "./jwt";
import { config } from "../config";

export const AT_COOKIE = "nexus_at";
export const RT_COOKIE = "nexus_rt";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AccessClaims;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireMfa: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireOperador: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  await app.register(cookie);

  app.decorate("requireAuth", async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies?.[AT_COOKIE];
    if (!token) {
      reply.code(401).send({ erro: "não autenticado" });
      return;
    }
    try {
      req.auth = await lerAccess(token);
    } catch {
      reply.code(401).send({ erro: "sessão inválida ou expirada" });
    }
  });

  app.decorate("requireMfa", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.auth) {
      reply.code(401).send({ erro: "não autenticado" });
      return;
    }
    if (!req.auth.mfa) {
      reply.code(403).send({ erro: "MFA necessário", precisaMfa: true });
    }
  });

  // Papéis: viewer = só leitura. operator+ pode operar (comandos, arquivos, etc.).
  app.decorate("requireOperador", async (req: FastifyRequest, reply: FastifyReply) => {
    const p = req.auth?.papel;
    if (!p || !["owner", "admin", "operator"].includes(p)) {
      reply.code(403).send({ erro: "sem permissão para esta ação (requer Operador ou superior)" });
    }
  });
  app.decorate("requireAdmin", async (req: FastifyRequest, reply: FastifyReply) => {
    const p = req.auth?.papel;
    if (!p || !["owner", "admin"].includes(p)) {
      reply.code(403).send({ erro: "sem permissão para esta ação (requer Admin)" });
    }
  });
};

export const authPlugin = fp(plugin, { name: "auth" });

const isProd = config.NODE_ENV === "production";

export function definirCookiesSessao(reply: FastifyReply, at: string, rt: string): void {
  const base = {
    httpOnly: true,
    secure: isProd,
    // A1: SameSite=Strict em produção previne CSRF — o cookie nunca é enviado
    // em requisições cross-site (incluindo navegação por links de outros domínios).
    sameSite: (isProd ? "strict" : "lax") as "strict" | "lax",
    path: "/",
    ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {}),
  };
  reply.setCookie(AT_COOKIE, at, { ...base, maxAge: 60 * 60 * 4 });
  reply.setCookie(RT_COOKIE, rt, { ...base, maxAge: 60 * 60 * 24 * 7 });
}

export function limparCookiesSessao(reply: FastifyReply): void {
  const base = { path: "/", ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {}) };
  reply.clearCookie(AT_COOKIE, base);
  reply.clearCookie(RT_COOKIE, base);
}
