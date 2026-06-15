"use client";

import React from "react";

interface KpiCardProps {
  titulo: string;
  valor: string | number;
  icon: React.ReactNode;
  cor: "emerald" | "red" | "amber" | "zinc" | "violet" | "cyan" | "white";
  subtitulo?: string;
  trend?: "up" | "down" | "neutral";
  onClick?: () => void;
}

const corMap: Record<
  KpiCardProps["cor"],
  { border: string; text: string; glow: string; badge: string }
> = {
  emerald: {
    border: "border-l-emerald-500",
    text: "text-emerald-400",
    glow: "hover:shadow-[0_0_18px_rgba(16,185,129,0.12)]",
    badge: "bg-emerald-500/10 text-emerald-400",
  },
  red: {
    border: "border-l-red-500",
    text: "text-red-400",
    glow: "hover:shadow-[0_0_18px_rgba(239,68,68,0.12)]",
    badge: "bg-red-500/10 text-red-400",
  },
  amber: {
    border: "border-l-amber-500",
    text: "text-amber-300",
    glow: "hover:shadow-[0_0_18px_rgba(245,158,11,0.12)]",
    badge: "bg-amber-500/10 text-amber-300",
  },
  zinc: {
    border: "border-l-zinc-500",
    text: "text-zinc-400",
    glow: "hover:shadow-[0_0_18px_rgba(161,161,170,0.08)]",
    badge: "bg-zinc-800 text-zinc-400",
  },
  violet: {
    border: "border-l-violet-500",
    text: "text-violet-400",
    glow: "hover:shadow-[0_0_18px_rgba(139,92,246,0.12)]",
    badge: "bg-violet-500/10 text-violet-400",
  },
  cyan: {
    border: "border-l-cyan-500",
    text: "text-cyan-400",
    glow: "hover:shadow-[0_0_18px_rgba(6,182,212,0.12)]",
    badge: "bg-cyan-500/10 text-cyan-400",
  },
  white: {
    border: "border-l-zinc-300",
    text: "text-white",
    glow: "hover:shadow-[0_0_18px_rgba(255,255,255,0.06)]",
    badge: "bg-zinc-800 text-zinc-200",
  },
};

const TrendArrow = ({ trend }: { trend: "up" | "down" | "neutral" }) => {
  if (trend === "up")
    return (
      <svg
        className="w-3.5 h-3.5 text-emerald-400"
        viewBox="0 0 16 16"
        fill="currentColor"
      >
        <path d="M8 3l5 6H3z" />
      </svg>
    );
  if (trend === "down")
    return (
      <svg
        className="w-3.5 h-3.5 text-red-400"
        viewBox="0 0 16 16"
        fill="currentColor"
      >
        <path d="M8 13L3 7h10z" />
      </svg>
    );
  return (
    <svg
      className="w-3.5 h-3.5 text-zinc-500"
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      <path d="M3 8h10v1H3z" />
    </svg>
  );
};

export default function KpiCard({
  titulo,
  valor,
  icon,
  cor,
  subtitulo,
  trend,
  onClick,
}: KpiCardProps) {
  const c = corMap[cor];
  const Tag = onClick ? "button" : "div";

  return (
    <Tag
      onClick={onClick}
      className={[
        "glass-panel rounded-2xl p-4 border border-zinc-800/80 border-l-4",
        c.border,
        c.glow,
        "transition-all duration-200 group",
        onClick ? "cursor-pointer text-left w-full" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest leading-none">
            {titulo}
          </p>
          <div className="flex items-end gap-2 mt-2">
            <span
              className={`text-3xl font-extrabold font-mono leading-none ${c.text}`}
            >
              {valor}
            </span>
            {trend && <TrendArrow trend={trend} />}
          </div>
          {subtitulo && (
            <p className="text-[10px] text-zinc-600 mt-1.5 font-mono">
              {subtitulo}
            </p>
          )}
        </div>
        <div
          className={`shrink-0 w-9 h-9 rounded-xl flex items-center justify-center ${c.badge} opacity-70 group-hover:opacity-100 transition-opacity`}
        >
          {icon}
        </div>
      </div>
    </Tag>
  );
}
