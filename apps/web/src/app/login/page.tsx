"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

function IconMonitor() {
  return (
    <svg className="w-5 h-5 text-zinc-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [codigoMfa, setCodigoMfa] = useState("");

  const [precisaMfa, setPrecisaMfa] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setCarregando(true);
    setErro(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          senha,
          ...(codigoMfa ? { codigoMfa } : {}),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.precisaMfa) {
          setPrecisaMfa(true);
        } else {
          setErro(data.erro || "Ocorreu um erro ao realizar o login.");
        }
        setCarregando(false);
        return;
      }

      // Cliente (portal) não é forçado a configurar MFA.
      if (data.precisaConfigurarMfa && data.usuario?.papel !== "cliente") {
        router.push("/mfa/setup");
      } else {
        router.push("/painel");
      }
    } catch {
      setErro("Não foi possível se conectar ao servidor.");
      setCarregando(false);
    }
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 sm:p-12">
      <div className="w-full max-w-md glass-panel-neon rounded-2xl p-8 relative overflow-hidden">
        {/* Blurs decorativos — 4 cantos */}
        <div className="absolute -top-16 -right-16 w-32 h-32 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none"></div>
        <div className="absolute -bottom-16 -left-16 w-32 h-32 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none"></div>
        <div className="absolute -top-12 -left-12 w-24 h-24 bg-violet-500/6 rounded-full blur-2xl pointer-events-none"></div>
        <div className="absolute -bottom-12 -right-12 w-24 h-24 bg-zinc-500/6 rounded-full blur-2xl pointer-events-none"></div>

        {/* Logo */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2.5 mb-3">
            <div className="relative">
              <IconMonitor />
              <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-500 border border-[#0f0f14] animate-pulse-subtle"></span>
            </div>
            <span className="font-extrabold text-base tracking-tight text-white">NEXUS</span>
            <span className="font-light text-base text-emerald-400 tracking-widest">RMM</span>
          </div>
          <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-semibold">
            Painel Administrativo
          </p>
        </div>

        {/* Erro */}
        {erro && (
          <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 glow-red shrink-0"></span>
            {erro}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {!precisaMfa ? (
            <>
              <div>
                <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                  E-mail
                </label>
                <input
                  type="email"
                  required
                  placeholder="admin@empresa.com.br"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl bg-zinc-900/60 border border-zinc-800 focus:border-emerald-500 focus:outline-none text-white transition-all placeholder:text-zinc-600 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                  Senha
                </label>
                <input
                  type="password"
                  required
                  placeholder="••••••••"
                  value={senha}
                  onChange={(e) => setSenha(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl bg-zinc-900/60 border border-zinc-800 focus:border-emerald-500 focus:outline-none text-white transition-all placeholder:text-zinc-600 text-sm"
                />
              </div>
            </>
          ) : (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
              <div className="mb-4 text-center">
                <p className="text-sm text-zinc-300">
                  Autenticação de Dois Fatores (MFA) exigida.
                </p>
                <p className="text-xs text-zinc-500 mt-1">
                  Digite o código de 6 dígitos gerado no seu aplicativo autenticador.
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 text-center">
                  Código de Autenticação
                </label>
                <input
                  type="text"
                  required
                  maxLength={6}
                  pattern="[0-9]*"
                  inputMode="numeric"
                  placeholder="000 000"
                  value={codigoMfa}
                  onChange={(e) => setCodigoMfa(e.target.value.replace(/\D/g, ""))}
                  className="w-full px-4 py-3 rounded-xl bg-zinc-900/60 border border-emerald-500/40 focus:border-emerald-500 focus:outline-none text-white text-center text-lg tracking-widest font-mono transition-all placeholder:text-zinc-600"
                />
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={carregando}
            className="w-full py-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:bg-emerald-500/40 text-black font-semibold text-sm transition-all focus:outline-none glow-emerald active:scale-[0.98] cursor-pointer flex items-center justify-center gap-2 mt-2"
          >
            {carregando ? (
              <span className="w-5 h-5 border-2 border-black border-t-transparent rounded-full animate-spin"></span>
            ) : precisaMfa ? (
              "Confirmar Código"
            ) : (
              "Entrar no Sistema"
            )}
          </button>

          {precisaMfa && (
            <button
              type="button"
              onClick={() => {
                setPrecisaMfa(false);
                setCodigoMfa("");
              }}
              className="w-full text-center text-xs text-zinc-500 hover:text-zinc-300 transition-colors py-1 cursor-pointer"
            >
              Voltar para senha
            </button>
          )}
        </form>

        {/* Link criar conta */}
        <Link
          href="/criar-conta"
          className="text-xs text-zinc-500 hover:text-emerald-400 text-center block mt-4 transition-colors"
        >
          Não tem conta? Criar grátis →
        </Link>

        {/* Indicador de segurança */}
        <p className="text-[10px] text-zinc-600 text-center mt-5 tracking-wide">
          Conexão segura · mTLS · Sessão criptografada
        </p>
      </div>
    </div>
  );
}
