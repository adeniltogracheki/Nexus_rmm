import { hash, verify } from "@node-rs/argon2";

const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashSenha(senha: string): Promise<string> {
  return hash(senha, OPTS);
}

export async function verificarSenha(hashArmazenado: string, senha: string): Promise<boolean> {
  try {
    return await verify(hashArmazenado, senha);
  } catch {
    return false;
  }
}
