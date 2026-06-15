"use client";

import React from "react";

interface HeaderProps {
  titulo: string;
  alertasList: any[];
  alertasNaoLidas: number;
  mostrarAlertas: boolean;
  onToggleAlertas: () => void;
  onMarcarTodasLidas: () => void;
  onMarcarAlertaLido: (a: any) => void;
}

/* ── Icons ──────────────────────────────────────────────────── */
const IconBell = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);

const IconCheck = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

/* ── Badge color logic ──────────────────────────────────────── */
function badgeColor(alertasList: any[], alertasNaoLidas: number) {
  if (alertasNaoLidas === 0) return "bg-zinc-700 text-zinc-300";
  const temCritico = alertasList.some(
    (a) => !a.lida && a.severidade === "critico"
  );
  if (temCritico) return "bg-red-500 text-white";
  return "bg-amber-500 text-zinc-900";
}

function bellBorderColor(alertasList: any[], alertasNaoLidas: number) {
  if (alertasNaoLidas === 0) return "border-zinc-800 hover:border-zinc-700";
  const temCritico = alertasList.some(
    (a) => !a.lida && a.severidade === "critico"
  );
  if (temCritico) return "border-red-500/30 hover:border-red-500/60";
  return "border-amber-500/30 hover:border-amber-500/60";
}

/* ── Alert item severity styles ─────────────────────────────── */
function severidadeStyle(s: string) {
  if (s === "critico")
    return {
      dot: "bg-red-500",
      text: "text-red-400",
      label: "CRÍTICO",
    };
  if (s === "aviso")
    return {
      dot: "bg-amber-500",
      text: "text-amber-400",
      label: "AVISO",
    };
  return {
    dot: "bg-blue-500",
    text: "text-blue-400",
    label: "INFO",
  };
}

/* ── Component ──────────────────────────────────────────────── */
export default function Header({
  titulo,
  alertasList,
  alertasNaoLidas,
  mostrarAlertas,
  onToggleAlertas,
  onMarcarTodasLidas,
  onMarcarAlertaLido,
}: HeaderProps) {
  // Split for grouped display
  const criticos = alertasList.filter((a) => a.severidade === "critico");
  const avisos = alertasList.filter((a) => a.severidade !== "critico");

  const badgeCls = badgeColor(alertasList, alertasNaoLidas);
  const bellBorderCls = bellBorderColor(alertasList, alertasNaoLidas);

  return (
    <header className="border-b border-zinc-800/80 bg-[#07070a]/60 backdrop-blur-md sticky top-0 z-30 px-5 py-3 flex items-center justify-between shrink-0">
      {/* Title */}
      <h2 className="text-base font-bold text-white tracking-tight truncate">
        {titulo}
      </h2>

      {/* Bell */}
      <div className="relative">
        <button
          onClick={onToggleAlertas}
          title="Alertas e notificações"
          className={[
            "relative flex items-center justify-center w-9 h-9 rounded-xl border bg-zinc-900/80 text-zinc-400 hover:text-zinc-100 transition-all duration-150 cursor-pointer",
            bellBorderCls,
          ].join(" ")}
        >
          <IconBell className="w-4 h-4" />
          {alertasNaoLidas > 0 && (
            <span
              className={[
                "absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center animate-pulse-subtle",
                badgeCls,
              ].join(" ")}
            >
              {alertasNaoLidas > 99 ? "99+" : alertasNaoLidas}
            </span>
          )}
        </button>

        {/* Dropdown */}
        {mostrarAlertas && (
          <div className="absolute right-0 mt-2 w-80 max-h-[480px] overflow-y-auto glass-panel-neon rounded-2xl border border-zinc-800 shadow-2xl z-50">
            {/* Dropdown header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/70 sticky top-0 bg-zinc-950/95 backdrop-blur-sm">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-white">Alertas</span>
                {alertasNaoLidas > 0 && (
                  <span
                    className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${badgeCls}`}
                  >
                    {alertasNaoLidas} não {alertasNaoLidas === 1 ? "lida" : "lidas"}
                  </span>
                )}
              </div>
              {alertasNaoLidas > 0 && (
                <button
                  onClick={onMarcarTodasLidas}
                  className="flex items-center gap-1 text-[10px] text-emerald-400 hover:text-emerald-300 transition-colors cursor-pointer"
                >
                  <IconCheck className="w-3 h-3" />
                  marcar todas
                </button>
              )}
            </div>

            {/* Empty */}
            {alertasList.length === 0 && (
              <div className="px-4 py-10 text-center">
                <div className="w-10 h-10 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto mb-3">
                  <IconCheck className="w-5 h-5 text-emerald-400" />
                </div>
                <p className="text-xs text-zinc-500">Nenhum alerta por aqui</p>
              </div>
            )}

            {/* Criticos group */}
            {criticos.length > 0 && (
              <>
                <div className="px-4 pt-3 pb-1">
                  <span className="text-[9px] font-bold tracking-widest text-red-500/80 uppercase">
                    Criticos
                  </span>
                </div>
                {criticos.map((a: any) => {
                  const s = severidadeStyle(a.severidade);
                  return (
                    <button
                      key={a.id}
                      onClick={() => onMarcarAlertaLido(a)}
                      className={`w-full text-left px-4 py-2.5 border-b border-zinc-900/60 text-xs hover:bg-zinc-900/50 transition-colors cursor-pointer ${
                        !a.lida ? "bg-red-500/5" : ""
                      }`}
                    >
                      <div className="flex items-start gap-2.5">
                        <span
                          className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1 ${s.dot}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-zinc-200 leading-snug">
                            {a.mensagem}
                          </div>
                          <div className="text-[10px] text-zinc-600 mt-0.5 font-mono">
                            {new Date(a.criadoEm).toLocaleString()}
                          </div>
                        </div>
                        {!a.lida && (
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0 mt-1" />
                        )}
                      </div>
                    </button>
                  );
                })}
              </>
            )}

            {/* Avisos/info group */}
            {avisos.length > 0 && (
              <>
                <div className="px-4 pt-3 pb-1">
                  <span className="text-[9px] font-bold tracking-widest text-amber-500/80 uppercase">
                    Avisos
                  </span>
                </div>
                {avisos.map((a: any) => {
                  const s = severidadeStyle(a.severidade);
                  return (
                    <button
                      key={a.id}
                      onClick={() => onMarcarAlertaLido(a)}
                      className={`w-full text-left px-4 py-2.5 border-b border-zinc-900/60 text-xs hover:bg-zinc-900/50 transition-colors cursor-pointer ${
                        !a.lida ? "bg-amber-500/5" : ""
                      }`}
                    >
                      <div className="flex items-start gap-2.5">
                        <span
                          className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1 ${s.dot}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-zinc-200 leading-snug">
                            {a.mensagem}
                          </div>
                          <div className="text-[10px] text-zinc-600 mt-0.5 font-mono">
                            {new Date(a.criadoEm).toLocaleString()}
                          </div>
                        </div>
                        {!a.lida && (
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0 mt-1" />
                        )}
                      </div>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
