"use client";

import React from "react";

interface MobileMenuProps {
  open: boolean;
  onClose: () => void;
  secao: string;
  user: any;
  pode: (cap: string) => boolean;
  socketConectado: boolean;
  onNavegar: (s: string) => void;
  onAbrirChamados: () => void;
  onAbrirTarefas: () => void;
  onAbrirUsuarios: () => void;
  onAbrirSeguranca: () => void;
  onAbrirPlanos: () => void;
  onAbrirTenants: () => void;
  onLogout: () => void;
}

const Row = ({ icon, label, active, onClick, danger }: {
  icon: React.ReactNode; label: string; active?: boolean; onClick: () => void; danger?: boolean;
}) => (
  <button
    onClick={onClick}
    className={[
      "w-full flex items-center gap-3 px-4 py-3.5 text-sm font-semibold transition-colors cursor-pointer select-none active:bg-zinc-800",
      danger ? "text-red-400" : active ? "text-emerald-300 bg-emerald-500/10" : "text-zinc-300",
    ].join(" ")}
  >
    <span className="w-5 h-5 flex items-center justify-center shrink-0">{icon}</span>
    {label}
  </button>
);

const Divider = () => <div className="h-px bg-zinc-800/80 mx-4 my-1" />;

export default function MobileMenu({
  open, onClose, secao, user, pode, socketConectado,
  onNavegar, onAbrirChamados, onAbrirTarefas, onAbrirUsuarios,
  onAbrirSeguranca, onAbrirPlanos, onAbrirTenants, onLogout,
}: MobileMenuProps) {
  if (!open) return null;

  const close = (fn: () => void) => () => { fn(); onClose(); };

  const inicial = user?.email?.[0]?.toUpperCase() ?? "?";
  const papelLabel: Record<string, string> = { owner: "Owner", admin: "Admin", operator: "Operador", viewer: "Viewer", cliente: "Cliente" };

  return (
    <>
      {/* Overlay */}
      <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm lg:hidden" onClick={onClose} />

      {/* Drawer bottom-up */}
      <div className="fixed bottom-0 inset-x-0 z-[51] lg:hidden bg-[#0c0c0f] border-t border-zinc-800 rounded-t-2xl pb-safe overflow-hidden animate-in slide-in-from-bottom duration-200">
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-2">
          <div className="w-10 h-1 rounded-full bg-zinc-700" />
        </div>

        {/* User info */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800/60">
          <div className="w-9 h-9 rounded-xl bg-zinc-800 border border-zinc-700 flex items-center justify-center text-sm font-bold text-zinc-300 shrink-0">
            {inicial}
          </div>
          <div className="min-w-0">
            <div className="text-xs text-zinc-300 font-semibold truncate">{user?.email}</div>
            <div className="text-[10px] text-zinc-500 capitalize">{papelLabel[user?.papel] ?? user?.papel}</div>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${socketConectado ? "bg-emerald-500" : "bg-red-500"}`} />
            <span className={`text-[10px] font-mono ${socketConectado ? "text-emerald-500/70" : "text-red-500/70"}`}>
              {socketConectado ? "Online" : "Offline"}
            </span>
          </div>
        </div>

        <div className="overflow-y-auto max-h-[60vh] pb-4">
          {pode("relatorios") && (
            <Row icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><rect x="7" y="10" width="3" height="8" rx="0.5"/><rect x="13" y="6" width="3" height="12" rx="0.5"/></svg>}
              label="Relatórios" active={secao === "relatorios"} onClick={close(() => onNavegar("relatorios"))} />
          )}
          {pode("chamados") && (
            <Row icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"><path d="M15 5H5a2 2 0 0 0-2 2v2a2 2 0 0 1 0 4v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2a2 2 0 0 1 0-4V7a2 2 0 0 0-2-2h-4"/><path d="M10 9h4M10 12h4M10 15h4"/></svg>}
              label="Chamados" onClick={close(onAbrirChamados)} />
          )}
          {pode("agendador") && (
            <Row icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>}
              label="Agendador" onClick={close(onAbrirTarefas)} />
          )}
          {pode("usuarios") && (
            <Row icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>}
              label="Usuários" onClick={close(onAbrirUsuarios)} />
          )}
          {pode("seguranca") && (
            <Row icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>}
              label="Segurança" active={secao === "seguranca"} onClick={close(onAbrirSeguranca)} />
          )}
          {(user?.papel === "owner" || user?.papel === "admin") && (
            <Row icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>}
              label="Planos" active={secao === "planos"} onClick={close(onAbrirPlanos)} />
          )}
          <Row icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M8 7h8M8 11h6"/></svg>}
            label="Documentação" active={secao === "docs"} onClick={close(() => onNavegar("docs"))} />

          {user?.superAdmin && (<>
            <Divider />
            <Row icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18M4 21V7l7-4 7 4v14"/><path d="M9 21v-5h6v5"/><rect x="9" y="9" width="2" height="2"/><rect x="13" y="9" width="2" height="2"/><rect x="9" y="13" width="2" height="2"/><rect x="13" y="13" width="2" height="2"/></svg>}
              label="Contas (SaaS)" active={secao === "tenants"} onClick={close(onAbrirTenants)} />
          </>)}

          <Divider />
          <Row icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>}
            label="Sair" danger onClick={close(onLogout)} />
        </div>
      </div>
    </>
  );
}
