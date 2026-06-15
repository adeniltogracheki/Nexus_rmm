import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { redis } from "../redis";

const secret = new TextEncoder().encode(config.JWT_SECRET);
const ALG = "HS256";
const REFRESH_TTL_SEC = 7 * 24 * 3600; // 7 dias

export interface AccessClaims {
  userId: string;
  tenantId: string;
  papel: string;
  mfa: boolean;
  /** Escopo por empresa (ids de grupos raiz). null = todas as empresas. */
  empresas?: string[] | null;
  /** Permissões granulares. null = padrão do papel. */
  permissoes?: string[] | null;
  email?: string;
}

export async function assinarAccess(c: AccessClaims): Promise<string> {
  return new SignJWT({ tenantId: c.tenantId, papel: c.papel, mfa: c.mfa, empresas: c.empresas ?? null, permissoes: c.permissoes ?? null, email: c.email ?? null })
    .setProtectedHeader({ alg: ALG })
    .setSubject(c.userId)
    .setIssuedAt()
    .setExpirationTime("4h")
    .sign(secret);
}

/**
 * Assina um refresh token com jti único, registrando no Redis.
 * Permite revogação server-side via revogarRefresh().
 */
export async function assinarRefresh(userId: string): Promise<string> {
  const jti = randomUUID();
  const token = await new SignJWT({ typ: "refresh" })
    .setProtectedHeader({ alg: ALG })
    .setSubject(userId)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret);
  // Registrar jti no Redis — presença = token válido
  await redis.set(`rt:${jti}`, userId, "EX", REFRESH_TTL_SEC);
  return token;
}

export async function lerAccess(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, secret);
  return {
    userId: String(payload.sub),
    tenantId: String(payload.tenantId),
    papel: String(payload.papel),
    mfa: payload.mfa === true,
    empresas: Array.isArray(payload.empresas) ? (payload.empresas as string[]) : null,
    permissoes: Array.isArray(payload.permissoes) ? (payload.permissoes as string[]) : null,
    email: typeof payload.email === "string" ? payload.email : undefined,
  };
}

export async function lerRefresh(token: string): Promise<{ userId: string; jti: string }> {
  const { payload }: { payload: JWTPayload } = await jwtVerify(token, secret);
  if (payload.typ !== "refresh") throw new Error("token não é refresh");
  const jti = payload.jti;
  if (!jti) throw new Error("refresh token sem jti");
  // Verificar se o jti ainda é válido no Redis (não foi revogado)
  const stored = await redis.get(`rt:${jti}`);
  if (!stored) throw new Error("refresh token revogado ou expirado");
  return { userId: String(payload.sub), jti };
}

/** Revoga um refresh token específico (logout, troca de senha, suspeita de roubo). */
export async function revogarRefresh(jti: string): Promise<void> {
  await redis.del(`rt:${jti}`);
}

/** Revoga todos os refresh tokens de um usuário (força logout em todos os dispositivos). */
export async function revogarTodosRefresh(userId: string): Promise<void> {
  // Escaneia todas as chaves rt:* cujo valor seja userId
  // Em produção com muitos usuários, preferir set dedicado por userId.
  // Para o volume atual, SCAN é aceitável.
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "rt:*", "COUNT", 100);
    cursor = nextCursor;
    if (keys.length > 0) {
      const values = await redis.mget(...keys);
      const toDelete = keys.filter((_, i) => values[i] === userId);
      if (toDelete.length > 0) await redis.del(...toDelete);
    }
  } while (cursor !== "0");
}
