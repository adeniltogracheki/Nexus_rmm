import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { LoginRequest, MfaVerifyRequest } from "@nexus/protocol";
import { db } from "../db";
import { redis } from "../redis";
import { usuarios } from "../db/schema";
import { verificarSenha } from "../auth/password";
import { gerarSegredoMfa, uriOtpauth, qrDataUrl, validarCodigoMfa } from "../auth/mfa";
import { assinarAccess, assinarRefresh, lerRefresh, revogarRefresh } from "../auth/jwt";
import { definirCookiesSessao, limparCookiesSessao, RT_COOKIE } from "../auth/plugin";
import { permissoesEfetivas } from "../permissoes";
import { getConfigSeguranca } from "../seguranca";
import { ehSuperAdmin } from "../superadmin";
import { featuresDoTenant, acessoInfo } from "../plano-guard";

async function usuarioPorId(id: string) {
  const rows = await db.select().from(usuarios).where(eq(usuarios.id, id)).limit(1);
  return rows[0];
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  // Rate-limit agressivo em todas as rotas de auth (5 req / 1min por IP)
  const authRateLimit = {
    config: {
      rateLimit: { max: 5, timeWindow: "1 minute" },
    },
  } as const;

  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = LoginRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ erro: "dados inválidos" });
    const { email, senha, codigoMfa } = parsed.data;

    // Anti força-bruta: bloqueia após muitas tentativas falhas (15 min).
    const chaveBloqueio = `login:fail:${email.toLowerCase()}`;
    const tentativas = Number(await redis.get(chaveBloqueio)) || 0;
    if (tentativas >= 8) {
      return reply.code(429).send({ erro: "Muitas tentativas. Aguarde alguns minutos e tente novamente." });
    }
    const registrarFalha = async () => {
      await redis.incr(chaveBloqueio);
      await redis.expire(chaveBloqueio, 900);
    };

    const rows = await db.select().from(usuarios).where(eq(usuarios.email, email)).limit(2);
    const u = rows[0];
    if (!u || !u.ativo) {
      await registrarFalha();
      return reply.code(401).send({ erro: "credenciais inválidas" });
    }
    if (rows.length > 1) {
      return reply.code(409).send({ erro: "email ambíguo entre tenants; contate o suporte" });
    }

    if (!(await verificarSenha(u.senhaHash, senha))) {
      await registrarFalha();
      return reply.code(401).send({ erro: "credenciais inválidas" });
    }

    const temMfa = !!u.mfaSecret;
    if (temMfa) {
      if (!codigoMfa) return reply.code(401).send({ erro: "código MFA necessário", precisaMfa: true });
      if (!validarCodigoMfa(u.mfaSecret as string, codigoMfa)) {
        await registrarFalha();
        return reply.code(401).send({ erro: "código MFA inválido" });
      }
    }

    await redis.del(chaveBloqueio); // login ok: zera o contador

    const at = await assinarAccess({ userId: u.id, tenantId: u.tenantId, papel: u.papel, mfa: temMfa, empresas: (u.empresasPermitidas as string[] | null) ?? null, permissoes: (u.permissoes as string[] | null) ?? null, email: u.email });
    const rt = await assinarRefresh(u.id);
    definirCookiesSessao(reply, at, rt);
    await db.update(usuarios).set({ ultimoLogin: new Date() }).where(eq(usuarios.id, u.id));

    return reply.send({
      ok: true,
      usuario: { id: u.id, email: u.email, papel: u.papel, tenantId: u.tenantId, mfaAtivo: temMfa },
      precisaConfigurarMfa: !temMfa,
    });
  });

  app.post("/api/auth/mfa/setup", { preHandler: [app.requireAuth], config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    const u = await usuarioPorId(req.auth!.userId);
    if (!u) return reply.code(404).send({ erro: "usuário não encontrado" });
    // Reusa o segredo PENDENTE se já existir (evita gerar outro a cada refresh — o
    // que invalidava o QR já escaneado e travava o usuário). Só vira ativo no verify.
    let segredo = (u.mfaPendente as string | null) || null;
    if (!segredo) {
      segredo = gerarSegredoMfa();
      await db.update(usuarios).set({ mfaPendente: segredo }).where(eq(usuarios.id, u.id));
    }
    const uri = uriOtpauth(u.email, segredo);
    return reply.send({ otpauthUri: uri, qrDataUrl: await qrDataUrl(uri) });
  });

  app.post("/api/auth/mfa/verify", { preHandler: [app.requireAuth], config: { rateLimit: { max: 5, timeWindow: "5 minutes" } } }, async (req, reply) => {
    const parsed = MfaVerifyRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ erro: "código inválido" });
    const u = await usuarioPorId(req.auth!.userId);
    const segredo = (u?.mfaPendente as string | null) || (u?.mfaSecret as string | null);
    if (!u || !segredo) return reply.code(400).send({ erro: "MFA não configurado" });
    if (!validarCodigoMfa(segredo, parsed.data.codigo)) {
      return reply.code(401).send({ erro: "código incorreto" });
    }
    // Confirmado: o pendente vira o ativo.
    if (u.mfaPendente) {
      await db.update(usuarios).set({ mfaSecret: u.mfaPendente, mfaPendente: null }).where(eq(usuarios.id, u.id));
    }
    const at = await assinarAccess({ userId: u.id, tenantId: u.tenantId, papel: u.papel, mfa: true, empresas: (u.empresasPermitidas as string[] | null) ?? null, permissoes: (u.permissoes as string[] | null) ?? null, email: u.email });
    const rt = await assinarRefresh(u.id);
    definirCookiesSessao(reply, at, rt);
    return reply.send({ ok: true });
  });

  app.post("/api/auth/refresh", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const rt = req.cookies?.[RT_COOKIE];
    if (!rt) return reply.code(401).send({ erro: "sem refresh" });
    let userId: string;
    let jti: string;
    try {
      ({ userId, jti } = await lerRefresh(rt));
    } catch {
      return reply.code(401).send({ erro: "refresh inválido" });
    }
    const u = await usuarioPorId(userId);
    if (!u || !u.ativo) return reply.code(401).send({ erro: "usuário inativo" });
    const mfa = !!u.mfaSecret;
    // Rotação: revogar o jti antigo antes de emitir o novo (evita replay)
    await revogarRefresh(jti);
    const novoAt = await assinarAccess({ userId: u.id, tenantId: u.tenantId, papel: u.papel, mfa, empresas: (u.empresasPermitidas as string[] | null) ?? null, permissoes: (u.permissoes as string[] | null) ?? null, email: u.email });
    const novoRt = await assinarRefresh(u.id);
    definirCookiesSessao(reply, novoAt, novoRt);
    return reply.send({ ok: true });
  });

  app.get("/api/auth/me", { preHandler: [app.requireAuth] }, async (req, reply) => {
    const u = await usuarioPorId(req.auth!.userId);
    if (!u) return reply.code(404).send({ erro: "não encontrado" });
    return reply.send({
      id: u.id,
      email: u.email,
      papel: u.papel,
      tenantId: u.tenantId,
      mfaAtivo: !!u.mfaSecret,
      mfaSatisfeito: req.auth!.mfa,
      permissoes: permissoesEfetivas(u.papel, u.permissoes as string[] | null),
      empresasPermitidas: (u.empresasPermitidas as string[] | null) ?? null,
      marca: { nome: getConfigSeguranca().nomeMarca, logoUrl: getConfigSeguranca().logoUrl },
      superAdmin: await ehSuperAdmin({ email: u.email, tenantId: u.tenantId }),
      planoFeatures: await featuresDoTenant(u.tenantId),
      acesso: await acessoInfo(u.tenantId),
    });
  });

  app.post("/api/auth/logout", async (req, reply) => {
    // Revogar o refresh token atual no Redis para invalidar sessão server-side
    const rt = req.cookies?.[RT_COOKIE];
    if (rt) {
      try {
        const { jti } = await lerRefresh(rt);
        await revogarRefresh(jti);
      } catch {
        // Token já expirado ou inválido — ok, apenas limpar cookie
      }
    }
    limparCookiesSessao(reply);
    return reply.send({ ok: true });
  });
};
