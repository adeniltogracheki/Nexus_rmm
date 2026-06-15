"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function MfaSetupPage() {
  const router = useRouter();
  const [qrCodeUrl, setQrCodeUrl] = useState("");
  const [otpUri, setOtpUri] = useState("");
  
  const [codigo, setCodigo] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [obtendoQr, setObtendoQr] = useState(true);

  // Busca dados do setup no mount
  useEffect(() => {
    async function carregarMfa() {
      try {
        const res = await fetch("/api/auth/mfa/setup", { method: "POST" });

        if (!res.ok) {
          if (res.status === 401) {
            router.push("/login");
            return;
          }
          throw new Error("Falha ao carregar configuração de MFA");
        }

        const data = await res.json();
        setQrCodeUrl(data.qrDataUrl);
        setOtpUri(data.otpauthUri);
      } catch (err) {
        setErro("Não foi possível carregar as configurações do MFA.");
      } finally {
        setObtendoQr(false);
      }
    }

    carregarMfa();
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setCarregando(true);
    setErro(null);

    try {
      const res = await fetch("/api/auth/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codigo }),
      });

      const data = await res.json();

      if (!res.ok) {
        setErro(data.erro || "Código inválido. Tente novamente.");
        setCarregando(false);
        return;
      }

      // Validado com sucesso! Redireciona para o painel
      router.push("/painel");
    } catch (err) {
      setErro("Falha ao se conectar com o servidor.");
      setCarregando(false);
    }
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 sm:p-12">
      <div className="w-full max-w-md glass-panel-neon rounded-2xl p-8 relative overflow-hidden text-center">
        {/* Glow Decorativo de fundo */}
        <div className="absolute -top-12 -right-12 w-24 h-24 bg-cyan-500/10 rounded-full blur-2xl"></div>

        <h1 className="text-2xl font-bold tracking-tight text-white mb-2 flex items-center justify-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-cyan-500 glow-cyan"></span>
          Configurar MFA
        </h1>
        <p className="text-sm text-zinc-400 mb-6">
          Proteja sua conta do Nexus RMM ativando a autenticação de dois fatores.
        </p>

        {erro && (
          <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm text-left flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 glow-red"></span>
            {erro}
          </div>
        )}

        {obtendoQr ? (
          <div className="flex flex-col items-center justify-center py-12">
            <span className="w-8 h-8 border-3 border-zinc-700 border-t-cyan-500 rounded-full animate-spin"></span>
            <p className="text-zinc-500 text-xs mt-3">Gerando QR Code seguro...</p>
          </div>
        ) : (
          <div className="animate-in fade-in zoom-in duration-300">
            {qrCodeUrl ? (
              <div className="bg-white p-4 rounded-2xl w-48 h-48 mx-auto mb-6 flex items-center justify-center shadow-lg">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qrCodeUrl} alt="MFA QR Code" className="w-full h-full" />
              </div>
            ) : (
              <div className="mb-6 text-zinc-500 text-sm">
                Não foi possível renderizar o QR Code visual.
              </div>
            )}

            <div className="text-left bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 mb-6 text-xs text-zinc-400 leading-relaxed">
              <span className="font-bold text-zinc-300 block mb-1">Instruções:</span>
              1. Abra seu app autenticador (Google Authenticator, Microsoft Authenticator, Authy, etc.).<br />
              2. Escaneie o QR Code acima.<br />
              3. Digite abaixo o código gerado no app para confirmar a sincronização.
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                  Código de Confirmação (6 dígitos)
                </label>
                <input
                  type="text"
                  required
                  maxLength={6}
                  pattern="[0-9]*"
                  inputMode="numeric"
                  placeholder="000 000"
                  value={codigo}
                  onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ""))}
                  className="w-full px-4 py-3 rounded-xl bg-zinc-900/60 border border-zinc-800 focus:border-cyan-500 focus:outline-none text-white text-center text-lg tracking-widest font-mono transition-all placeholder:text-zinc-600"
                />
              </div>

              <button
                type="submit"
                disabled={carregando || !codigo}
                className="w-full py-3.5 rounded-xl bg-cyan-500 hover:bg-cyan-600 disabled:bg-cyan-500/40 text-black font-semibold text-sm transition-all focus:outline-none glow-cyan active:scale-98 cursor-pointer flex items-center justify-center gap-2"
              >
                {carregando ? (
                  <span className="w-5 h-5 border-2 border-black border-t-transparent rounded-full animate-spin"></span>
                ) : (
                  "Ativar e Continuar"
                )}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
