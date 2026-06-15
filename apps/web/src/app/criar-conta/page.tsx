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

function IconCheckCircle() {
  return (
    <svg className="w-12 h-12 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path className="animate-fade-in-up" d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function calcForca(senha: string): number {
  if (senha.length === 0) return 0;
  if (senha.length < 8) return 1;
  if (senha.length < 12 && !/[A-Z]/.test(senha)) return 2;
  if (senha.length >= 12 && /[A-Z]/.test(senha) && /[0-9]/.test(senha)) return 4;
  return 3;
}

const forcaCor = ["", "bg-red-500", "bg-amber-500", "bg-yellow-400", "bg-emerald-500"];
const forcaLabel = ["", "Fraca", "Regular", "Boa", "Forte"];
const forcaTextCor = ["", "text-red-400", "text-amber-400", "text-yellow-400", "text-emerald-400"];

export default function CriarContaPage() {
  const router = useRouter();
  const [empresa, setEmpresa] = useState("");
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const forca = calcForca(senha);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    if (senha.length < 8) { setErro("A senha precisa de ao menos 8 caracteres."); return; }
    setCarregando(true);
    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ empresa, email, senha }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setErro(data.erro || "Não foi possível criar a conta."); setCarregando(false); return; }
      setOk(true);
      setTimeout(() => router.push("/login"), 2200);
    } catch {
      setErro("Falha ao conectar com o servidor.");
      setCarregando(false);
    }
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 sm:p-12">
      <div className="w-full max-w-md glass-panel-neon rounded-2xl p-8 relative overflow-hidden">
        {/* Blurs decorativos */}
        <div className="absolute -top-16 -right-16 w-32 h-32 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none"></div>
        <div className="absolute -bottom-16 -left-16 w-32 h-32 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none"></div>
        <div className="absolute -top-12 -left-12 w-24 h-24 bg-violet-500/6 rounded-full blur-2xl pointer-events-none"></div>
        <div className="absolute -bottom-12 -right-12 w-24 h-24 bg-zinc-500/6 rounded-full blur-2xl pointer-events-none"></div>

        {/* Logo */}
        <div className="text-center mb-6">
          <div className="flex items-center justify-center gap-2.5 mb-3">
            <div className="relative">
              <IconMonitor />
              <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-500 border border-[#0f0f14] animate-pulse-subtle"></span>
            </div>
            <span className="font-extrabold text-base tracking-tight text-white">NEXUS</span>
            <span className="font-light text-base text-emerald-400 tracking-widest">RMM</span>
          </div>
          <h1 className="text-xl font-bold text-white">Criar conta grátis</h1>
          <p className="text-xs text-zinc-500 mt-1">1 máquina grátis. Sem cartão de crédito.</p>
        </div>

        {ok ? (
          <div className="text-center py-8 animate-fade-in-up">
            <div className="flex justify-center mb-4">
              <IconCheckCircle />
            </div>
            <p className="text-emerald-300 font-semibold">Conta criada com sucesso!</p>
            <p className="text-zinc-500 text-sm mt-1">Redirecionando para o login…</p>
          </div>
        ) : (
          <>
            {erro && (
              <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-start gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0 mt-1.5"></span>
                {erro}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-3">
              <input
                value={empresa}
                onChange={(e) => setEmpresa(e.target.value)}
                required
                placeholder="Nome da sua empresa"
                className="w-full px-4 py-3 rounded-xl bg-zinc-900/60 border border-zinc-800 focus:border-emerald-500 focus:outline-none text-white text-sm placeholder:text-zinc-600 transition-colors"
              />
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                type="email"
                placeholder="Seu melhor e-mail"
                className="w-full px-4 py-3 rounded-xl bg-zinc-900/60 border border-zinc-800 focus:border-emerald-500 focus:outline-none text-white text-sm placeholder:text-zinc-600 transition-colors"
              />

              {/* Senha + indicador de força */}
              <div className="space-y-2">
                <input
                  value={senha}
                  onChange={(e) => setSenha(e.target.value)}
                  required
                  type="password"
                  placeholder="Crie uma senha (mín. 8 caracteres)"
                  className="w-full px-4 py-3 rounded-xl bg-zinc-900/60 border border-zinc-800 focus:border-emerald-500 focus:outline-none text-white text-sm placeholder:text-zinc-600 transition-colors"
                />

                {senha.length > 0 && (
                  <div className="space-y-1.5">
                    {/* Barra de 4 segmentos */}
                    <div className="flex gap-1">
                      {[1, 2, 3, 4].map((i) => (
                        <div
                          key={i}
                          className={`h-1 flex-1 rounded-full transition-all duration-300 ${
                            i <= forca ? forcaCor[forca] : "bg-zinc-800"
                          }`}
                        />
                      ))}
                    </div>
                    <p className={`text-[10px] font-medium ${forcaTextCor[forca]}`}>
                      Senha {forcaLabel[forca]}
                    </p>
                  </div>
                )}
              </div>

              <button
                type="submit"
                disabled={carregando}
                className="w-full py-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:bg-emerald-500/40 text-black font-semibold text-sm transition-all glow-emerald active:scale-[0.98] cursor-pointer mt-1"
              >
                {carregando ? (
                  <span className="inline-flex items-center gap-2 justify-center">
                    <span className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin"></span>
                    Criando…
                  </span>
                ) : (
                  "Criar minha conta grátis"
                )}
              </button>
            </form>

            {/* Link já tem conta */}
            <Link
              href="/login"
              className="text-xs text-zinc-500 hover:text-emerald-400 text-center block mt-4 transition-colors"
            >
              Já tem conta? Entrar →
            </Link>

            <p className="text-[10px] text-zinc-600 text-center mt-4 tracking-wide">
              Conexão segura · mTLS · Sessão criptografada
            </p>
          </>
        )}
      </div>
    </div>
  );
}
