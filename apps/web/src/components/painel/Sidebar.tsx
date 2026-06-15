"use client";

import React from "react";

interface UserMe {
  id: string;
  email: string;
  papel: string;
  tenantId: string;
  mfaAtivo: boolean;
  mfaSatisfeito: boolean;
  permissoes?: string[];
  marca?: { nome?: string; logoUrl?: string };
  superAdmin?: boolean;
  planoFeatures?: string[];
  acesso?: {
    plano: string;
    bloqueado: boolean;
    motivo: "trial" | "vencido" | null;
    vencimento: string | null;
    diasRestantes: number;
  };
}

interface SidebarProps {
  secao: string;
  socketConectado: boolean;
  user: UserMe | null;
  alertasNaoLidas: number;
  pode: (cap: string) => boolean;
  onNavegar: (secao: string) => void;
  onAbrirChamados: () => void;
  onAbrirTarefas: () => void;
  onAbrirUsuarios: () => void;
  onAbrirSeguranca: () => void;
  onAbrirPlanos: () => void;
  onAbrirTenants: () => void;
  onLogout: () => void;
}

/* ── SVG icons ──────────────────────────────────────────────── */
const IconMonitor = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

const IconGrid = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
);

const IconBuilding = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 21h18M6 21V7l6-4 6 4v14" />
    <path d="M9 21v-4h6v4" />
    <path d="M9 10h.01M15 10h.01M9 14h.01M15 14h.01" />
  </svg>
);

const IconChartBar = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 3v18h18" />
    <rect x="7" y="10" width="3" height="8" rx="0.5" />
    <rect x="13" y="6" width="3" height="12" rx="0.5" />
  </svg>
);

const IconTicket = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M15 5H5a2 2 0 0 0-2 2v2a2 2 0 0 1 0 4v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2a2 2 0 0 1 0-4V7a2 2 0 0 0-2-2h-4" />
    <path d="M10 9h4M10 12h4M10 15h4" />
  </svg>
);

const IconClock = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 3" />
  </svg>
);

const IconUsers = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

const IconLock = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

const IconCard = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M2 10h20" />
  </svg>
);

const IconBuildings = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 21h18M4 21V7l7-4 7 4v14" />
    <path d="M9 21v-5h6v5" />
    <rect x="9" y="9" width="2" height="2" />
    <rect x="13" y="9" width="2" height="2" />
    <rect x="9" y="13" width="2" height="2" />
    <rect x="13" y="13" width="2" height="2" />
  </svg>
);

const IconLogout = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
);

const IconBook = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    <path d="M8 7h8M8 11h6" />
  </svg>
);

/* ── Nav item definition ────────────────────────────────────── */
const mainNav = [
  { k: "dashboard", icon: IconGrid, t: "Dashboard", cap: "ver_maquinas" },
  { k: "empresas", icon: IconBuilding, t: "Empresas", cap: "ver_maquinas" },
  { k: "maquinas", icon: IconMonitor, t: "Máquinas", cap: "ver_maquinas" },
  { k: "relatorios", icon: IconChartBar, t: "Relatórios", cap: "relatorios" },
] as const;

/* ── Component ──────────────────────────────────────────────── */
export default function Sidebar({
  secao,
  socketConectado,
  user,
  pode,
  onNavegar,
  onAbrirChamados,
  onAbrirTarefas,
  onAbrirUsuarios,
  onAbrirSeguranca,
  onAbrirPlanos,
  onAbrirTenants,
  onLogout,
}: SidebarProps) {
  const [colapsada, setColapsada] = React.useState(false);
  const inicial = user?.email?.[0]?.toUpperCase() ?? "?";
  const papel = user?.papel ?? "";
  const papelLabel: Record<string, string> = {
    owner: "Owner",
    admin: "Admin",
    operator: "Operador",
    viewer: "Viewer",
    cliente: "Cliente",
  };

  // Helper: botão de nav com tooltip quando colapsado
  function NavBtn({
    onClick,
    icon: Icon,
    label,
    active,
    violet,
    title,
  }: {
    onClick: () => void;
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    active?: boolean;
    violet?: boolean;
    title?: string;
  }) {
    const activeClass = violet
      ? "bg-violet-500/15 text-violet-300 border border-violet-500/20"
      : "bg-emerald-500/10 text-emerald-300 border border-emerald-500/20";
    return (
      <button
        onClick={onClick}
        title={colapsada ? (title ?? label) : undefined}
        className={[
          "w-full flex items-center rounded-lg font-semibold transition-all duration-150 cursor-pointer border",
          colapsada ? "justify-center px-0 py-2.5" : "gap-2.5 px-3 py-2 text-sm",
          active
            ? activeClass
            : "text-zinc-400 hover:bg-zinc-900/70 hover:text-zinc-200 border-transparent",
        ].join(" ")}
      >
        <Icon className="w-4 h-4 shrink-0" />
        {!colapsada && <span>{label}</span>}
      </button>
    );
  }

  return (
    <aside
      className={[
        "hidden lg:flex shrink-0 flex-col border-r border-zinc-800/70 bg-[#07070a] transition-all duration-200",
        colapsada ? "w-14" : "w-56",
      ].join(" ")}
    >
      {/* Logo + toggle */}
      <div className={["border-b border-zinc-800/70", colapsada ? "px-2 pt-3 pb-3" : "px-4 pt-5 pb-4"].join(" ")}>
        {!colapsada && (
          <div className="flex items-center gap-2.5 mb-2">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0">
              <IconMonitor className="w-4 h-4 text-emerald-400" />
            </div>
            <span className="text-[15px] font-bold tracking-tight text-white">
              NEXUS <span className="text-emerald-400 font-light">RMM</span>
            </span>
          </div>
        )}
        {colapsada && (
          <div className="flex justify-center mb-2">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
              <IconMonitor className="w-4 h-4 text-emerald-400" />
            </div>
          </div>
        )}
        {/* Connection + collapse toggle */}
        <div className={["flex items-center", colapsada ? "justify-center" : "justify-between pl-0.5"].join(" ")}>
          {!colapsada && (
            <div className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${socketConectado ? "bg-emerald-500" : "bg-red-500 animate-pulse"}`} />
              <span className={`text-[10px] font-mono ${socketConectado ? "text-emerald-500/70" : "text-red-500/70"}`}>
                {socketConectado ? "Conectado" : "Sem conexão"}
              </span>
            </div>
          )}
          <button
            onClick={() => setColapsada((v) => !v)}
            title={colapsada ? "Expandir menu" : "Recolher menu"}
            className="w-6 h-6 rounded-md flex items-center justify-center text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              {colapsada
                ? <><path d="M9 18l6-6-6-6"/></>
                : <><path d="M15 18l-6-6 6-6"/></>
              }
            </svg>
          </button>
        </div>
      </div>

      {/* Nav */}
      <nav className={["flex-1 space-y-0.5 overflow-y-auto overflow-x-hidden", colapsada ? "p-1.5" : "p-2.5"].join(" ")}>
        {(mainNav.filter((it) => pode(it.cap)) as typeof mainNav[number][]).map((it) => (
          <NavBtn
            key={it.k}
            onClick={() => onNavegar(it.k)}
            icon={it.icon}
            label={it.t}
            active={secao === it.k}
          />
        ))}

        <div className="h-px bg-zinc-800/60 my-2 mx-1" />

        {pode("chamados") && (
          <NavBtn onClick={onAbrirChamados} icon={IconTicket} label="Chamados" />
        )}
        {pode("agendador") && (
          <NavBtn onClick={onAbrirTarefas} icon={IconClock} label="Agendador" />
        )}
        {pode("usuarios") && (
          <NavBtn onClick={onAbrirUsuarios} icon={IconUsers} label="Usuários" />
        )}
        {pode("seguranca") && (
          <NavBtn onClick={onAbrirSeguranca} icon={IconLock} label="Segurança" active={secao === "seguranca"} />
        )}
        {(user?.papel === "owner" || user?.papel === "admin") && (
          <NavBtn onClick={onAbrirPlanos} icon={IconCard} label="Planos" active={secao === "planos"} />
        )}
        <NavBtn onClick={() => onNavegar("docs")} icon={IconBook} label="Docs" active={secao === "docs"} />
        {user?.superAdmin && (
          <NavBtn onClick={onAbrirTenants} icon={IconBuildings} label="Contas (SaaS)" active={secao === "tenants"} violet />
        )}
      </nav>

      {/* Footer */}
      <div className={["border-t border-zinc-800/70 space-y-2", colapsada ? "p-1.5" : "p-2.5"].join(" ")}>
        {!colapsada && (
          <div className="flex items-center gap-2.5 px-1 py-1">
            <div className="w-7 h-7 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center text-xs font-bold text-zinc-300 shrink-0">
              {inicial}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] text-zinc-400 font-mono truncate leading-tight">{user?.email}</div>
              <div className="text-[9px] text-zinc-600 leading-tight capitalize">{papelLabel[papel] ?? papel}</div>
            </div>
          </div>
        )}
        {colapsada && (
          <div className="flex justify-center py-1">
            <div className="w-7 h-7 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center text-xs font-bold text-zinc-300" title={user?.email ?? ""}>
              {inicial}
            </div>
          </div>
        )}
        <button
          onClick={onLogout}
          title={colapsada ? "Sair" : undefined}
          className={[
            "w-full flex items-center rounded-lg bg-zinc-900/60 border border-zinc-800/80 hover:border-red-500/30 hover:text-red-400 text-zinc-500 text-xs font-semibold cursor-pointer transition-all duration-150",
            colapsada ? "justify-center px-0 py-2.5" : "gap-2 px-3 py-2",
          ].join(" ")}
        >
          <IconLogout className="w-3.5 h-3.5 shrink-0" />
          {!colapsada && "Sair"}
        </button>
      </div>
    </aside>
  );
}
