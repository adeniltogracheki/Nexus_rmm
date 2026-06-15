import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { comTenant } from "./db/tenant";
import { grupos, maquinas } from "./db/schema";
import type { AccessClaims } from "./auth/jwt";

/**
 * Escopo por empresa: usuários podem ser restritos a empresas específicas
 * (grupos raiz). claims.empresas null/vazio = acesso a todas (sem restrição).
 */

/** Mapa grupoId -> empresaRaizId do tenant (sobe a árvore de departamentos). */
export async function mapaEmpresaRaiz(tenantId: string): Promise<Map<string, string>> {
  const rows = await comTenant(tenantId, (tdb) =>
    tdb.select({ id: grupos.id, parentId: grupos.parentId }).from(grupos),
  );
  const pai = new Map(rows.map((g) => [g.id, g.parentId]));
  const raiz = new Map<string, string>();
  for (const g of rows) {
    let atual: string = g.id;
    let topo: string = g.id;
    for (let i = 0; i < 10; i++) {
      const p = pai.get(atual);
      if (!p) { topo = atual; break; }
      atual = p;
      topo = p;
    }
    raiz.set(g.id, topo);
  }
  return raiz;
}

export function temRestricao(claims: AccessClaims | undefined): boolean {
  return !!claims?.empresas && claims.empresas.length > 0;
}

/** A máquina (pelo grupoId dela) está dentro do escopo do usuário? */
export async function grupoNoEscopo(claims: AccessClaims, grupoId: string | null): Promise<boolean> {
  if (!temRestricao(claims)) return true;
  if (!grupoId) return false; // máquina sem empresa: invisível para usuário restrito
  const raiz = await mapaEmpresaRaiz(claims.tenantId);
  const empresa = raiz.get(grupoId);
  return !!empresa && (claims.empresas as string[]).includes(empresa);
}

/**
 * preHandler para rotas /api/maquinas/:id/* — bloqueia acesso a máquinas fora
 * do escopo de empresa do usuário (404 para não revelar existência).
 */
export async function requireEscopoMaquina(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const claims = req.auth;
  if (!claims || !temRestricao(claims)) return;
  const { id } = req.params as { id?: string };
  if (!id) return;
  try {
    const m = (
      await comTenant(claims.tenantId, (tdb) =>
        tdb.select({ grupoId: maquinas.grupoId }).from(maquinas).where(eq(maquinas.id, id)).limit(1),
      )
    )[0];
    if (!m || !(await grupoNoEscopo(claims, m.grupoId))) {
      reply.code(404).send({ erro: "máquina não encontrada" });
    }
  } catch {
    reply.code(404).send({ erro: "máquina não encontrada" });
  }
}
