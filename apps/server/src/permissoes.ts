import type { FastifyReply, FastifyRequest } from "fastify";
import type { AccessClaims } from "./auth/jwt";

/**
 * Permissões granulares (capabilities). O super admin (owner) tem todas, sempre.
 * Cada usuário pode receber um conjunto explícito; sem conjunto = padrão do papel.
 * Lista null/undefined no banco = deriva do papel (compatibilidade com usuários antigos).
 */
export const CAPS = [
  "ver_maquinas",   // ver a lista de máquinas
  "acesso_remoto",  // abrir a tela (VNC)
  "terminal",       // abrir o terminal
  "servicos",       // controlar serviços do Windows
  "arquivos",       // gerenciador de arquivos
  "inventario",     // ficha técnica / inventário
  "metricas",       // métricas/gráficos
  "relatorios",     // relatórios
  "agendador",      // tarefas agendadas
  "chamados",       // chamados/helpdesk
  "usuarios",       // gerir usuários e permissões
  "empresas",       // gerir empresas/departamentos
  "seguranca",      // painel de segurança
] as const;

export type Cap = (typeof CAPS)[number];

const PADRAO_PAPEL: Record<string, Cap[]> = {
  owner: [...CAPS],
  admin: [...CAPS],
  operator: ["ver_maquinas", "acesso_remoto", "terminal", "servicos", "arquivos", "inventario", "metricas", "relatorios", "agendador", "chamados"],
  viewer: ["ver_maquinas", "inventario", "metricas", "relatorios"],
  // Cliente final (portal): só vê o que é dele, abre chamado. Sem controle operacional.
  cliente: ["ver_maquinas", "metricas", "relatorios", "chamados"],
};

/** Lista efetiva de permissões de um usuário. */
export function permissoesEfetivas(papel: string, permissoes: string[] | null | undefined): Cap[] {
  if (papel === "owner") return [...CAPS];
  if (Array.isArray(permissoes)) {
    return permissoes.filter((p): p is Cap => (CAPS as readonly string[]).includes(p));
  }
  return PADRAO_PAPEL[papel] ?? [];
}

export function temPermissao(claims: AccessClaims | undefined, cap: Cap): boolean {
  if (!claims) return false;
  if (claims.papel === "owner") return true;
  return permissoesEfetivas(claims.papel, claims.permissoes).includes(cap);
}

/** preHandler que exige uma permissão específica. */
export function requirePermissao(cap: Cap) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!temPermissao(req.auth, cap)) {
      reply.code(403).send({ erro: `sem permissão (${cap})` });
    }
  };
}
