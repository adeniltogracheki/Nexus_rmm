"use client";

import React from "react";

interface BottomNavProps {
  secao: string;
  alertasNaoLidas: number;
  socketConectado: boolean;
  pode: (cap: string) => boolean;
  onNavegar: (secao: string) => void;
  onAbrirMenu: () => void; // abre drawer "mais"
}

const IconGrid = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
    <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
  </svg>
);
const IconMonitor = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
  </svg>
);
const IconBuilding = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 21h18M6 21V7l6-4 6 4v14"/><path d="M9 21v-4h6v4"/>
  </svg>
);
const IconBell = ({ n }: { n: number }) => (
  <div className="relative">
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </svg>
    {n > 0 && (
      <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] rounded-full bg-red-500 text-[9px] font-bold text-white flex items-center justify-center px-0.5 leading-none">
        {n > 9 ? "9+" : n}
      </span>
    )}
  </div>
);
const IconMenu = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
    <line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>
  </svg>
);

export default function BottomNav({
  secao,
  alertasNaoLidas,
  socketConectado,
  pode,
  onNavegar,
  onAbrirMenu,
}: BottomNavProps) {
  const items = [
    { k: "dashboard", icon: <IconGrid />,    label: "Dashboard", cap: "ver_maquinas" },
    { k: "maquinas",  icon: <IconMonitor />, label: "Máquinas",  cap: "ver_maquinas" },
    { k: "empresas",  icon: <IconBuilding />,label: "Empresas",  cap: "ver_maquinas" },
    { k: "alertas",   icon: <IconBell n={alertasNaoLidas} />, label: "Alertas", cap: "ver_maquinas" },
  ].filter((it) => pode(it.cap));

  return (
    <nav className="fixed bottom-0 inset-x-0 z-50 flex lg:hidden h-16 bg-[#07070a]/95 backdrop-blur border-t border-zinc-800 safe-area-bottom">
      {/* Indicador de conexão — faixa top */}
      <div className={`absolute top-0 inset-x-0 h-0.5 ${socketConectado ? "bg-emerald-500/60" : "bg-red-500/60"}`} />

      {items.map((it) => {
        const active = secao === it.k || (it.k === "alertas" && secao === "alertas");
        return (
          <button
            key={it.k}
            onClick={() => it.k === "alertas" ? onAbrirMenu() : onNavegar(it.k)}
            className={[
              "flex-1 flex flex-col items-center justify-center gap-1 py-2 transition-colors cursor-pointer select-none active:scale-95",
              active ? "text-emerald-400" : "text-zinc-500",
            ].join(" ")}
          >
            {it.icon}
            <span className="text-[10px] font-semibold leading-none">{it.label}</span>
          </button>
        );
      })}

      {/* Botão "Mais" */}
      <button
        onClick={onAbrirMenu}
        className="flex-1 flex flex-col items-center justify-center gap-1 py-2 text-zinc-500 transition-colors cursor-pointer select-none active:scale-95"
      >
        <IconMenu />
        <span className="text-[10px] font-semibold leading-none">Mais</span>
      </button>
    </nav>
  );
}
