// Planos de assinatura + features liberadas por plano (engine de cobrança).
export type PlanoId = "trial" | "essencial" | "pro" | "enterprise";

const TODAS = [
  "acesso_remoto", "terminal", "servicos", "arquivos", "relatorios",
  "relatorios_avancados", "manutencao", "scripts", "portal_cliente",
  "notificacoes", "multi_empresa", "ia_remediacao",
];

export const PLANOS: Record<PlanoId, { nome: string; maxMaquinas: number; precoMes: number | null; features: string[] }> = {
  // Trial = só o "gostinho": 1 máquina, recursos essenciais (tela + terminal + relatório básico).
  trial: { nome: "Trial", maxMaquinas: 1, precoMes: 0, features: ["acesso_remoto", "terminal", "relatorios"] },
  essencial: { nome: "Essencial", maxMaquinas: 25, precoMes: 149, features: ["acesso_remoto", "terminal", "servicos", "arquivos", "relatorios", "notificacoes", "multi_empresa"] },
  pro: { nome: "Pro", maxMaquinas: 150, precoMes: 399, features: [...TODAS] },
  enterprise: { nome: "Enterprise", maxMaquinas: 100000, precoMes: null, features: [...TODAS] },
};

export const FEATURES_LABEL: Record<string, string> = {
  acesso_remoto: "Acesso remoto (tela)",
  terminal: "Terminal",
  servicos: "Serviços do Windows",
  arquivos: "Arquivos",
  relatorios: "Relatórios básicos",
  relatorios_avancados: "Relatórios avançados (auditoria/inventário)",
  manutencao: "Gestão de manutenção",
  scripts: "Biblioteca de scripts",
  portal_cliente: "Portal do cliente",
  notificacoes: "Notificações/alertas externos",
  multi_empresa: "Múltiplas empresas",
  ia_remediacao: "IA remediação com aprovação humana (add-on)",
};

export function planoDe(plano: string | null | undefined) {
  return PLANOS[(plano as PlanoId)] || PLANOS.trial;
}
export function planoTem(plano: string | null | undefined, feature: string): boolean {
  return planoDe(plano).features.includes(feature);
}
