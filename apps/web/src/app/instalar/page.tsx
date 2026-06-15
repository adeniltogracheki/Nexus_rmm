import Link from "next/link";

export const metadata = {
  title: "Instalar Agente — Nexus RMM",
  description: "Instale o agente Nexus RMM em Windows, Linux ou macOS com um único comando.",
};

function CopyBox({ cmd, label }: { cmd: string; label: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 overflow-hidden">
      <div className="px-4 py-2 bg-zinc-900/60 border-b border-zinc-800 flex items-center justify-between">
        <span className="text-[11px] text-zinc-500 font-mono">{label}</span>
      </div>
      <div className="px-4 py-3 bg-zinc-950 flex items-center gap-3">
        <code className="flex-1 text-xs text-emerald-300 font-mono break-all leading-relaxed">{cmd}</code>
      </div>
    </div>
  );
}

export default function InstalarPage() {
  const BASE = "https://rmm.gmtec.tec.br";

  const plataformas = [
    {
      os: "Windows",
      icon: "⊞",
      cor: "sky",
      min: "Windows 10 / Server 2016+",
      cmd: `irm ${BASE}/i | iex`,
      shell: "PowerShell (Admin)",
      passos: [
        "Abra o PowerShell como Administrador",
        "Cole o comando acima e pressione Enter",
        "O agente instala, configura e conecta automaticamente",
        "Em segundos ele aparece online no painel",
      ],
      apk: null,
    },
    {
      os: "Linux",
      icon: "🐧",
      cor: "amber",
      min: "Ubuntu 20.04+ / Debian 11+ / RHEL 8+",
      cmd: `curl -fsSL ${BASE}/instalar-linux.sh | sudo bash`,
      shell: "Terminal (root)",
      passos: [
        "Abra o terminal com permissões de root (ou sudo)",
        "Cole o comando acima e pressione Enter",
        "O script instala Node.js, o agente e configura o systemd",
        "O agente conecta e aparece online no painel",
      ],
      apk: null,
    },
    {
      os: "macOS",
      icon: "",
      cor: "violet",
      min: "macOS 12 Monterey+",
      cmd: `curl -fsSL ${BASE}/instalar-macos.sh | sudo bash`,
      shell: "Terminal",
      passos: [
        "Abra o Terminal (Applications → Utilities)",
        "Cole o comando acima e pressione Enter",
        "O script instala via Homebrew e configura o LaunchDaemon",
        "O agente conecta e aparece online no painel",
      ],
      apk: null,
    },
    {
      os: "Android",
      icon: "🤖",
      cor: "emerald",
      min: "Android 8.0+ (API 26+)",
      cmd: null,
      shell: null,
      passos: [
        "Baixe o APK abaixo e transfira para o dispositivo",
        "Em Configurações, habilite Instalar apps desconhecidos",
        "Abra o APK e instale",
        "No app, informe a URL do servidor e o token gerado no painel",
        "Para controle remoto: ative o serviço de Acessibilidade Nexus RMM",
      ],
      apk: `${BASE}/nexus-rmm-agent.apk`,
    },
  ];

  const corMap: Record<string, string> = {
    sky: "border-sky-500/30 bg-sky-500/5 text-sky-300",
    amber: "border-amber-500/30 bg-amber-500/5 text-amber-300",
    violet: "border-violet-500/30 bg-violet-500/5 text-violet-300",
    emerald: "border-emerald-500/30 bg-emerald-500/5 text-emerald-300",
  };

  return (
    <div className="min-h-screen bg-[#09090b] text-white">
      {/* Header */}
      <header className="border-b border-white/[0.06] px-6 py-4 flex items-center justify-between max-w-5xl mx-auto">
        <Link href="/" className="text-sm font-bold tracking-tight text-white hover:text-emerald-400 transition-colors">
          ← Nexus RMM
        </Link>
        <Link
          href="/login"
          className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-black text-xs font-bold transition-colors"
        >
          Acessar Painel
        </Link>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-16">
        {/* Hero */}
        <div className="text-center mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-emerald-500/30 bg-emerald-500/5 text-xs text-emerald-300 mb-5">
            v0.6.3 — Windows · Linux · macOS · Android
          </div>
          <h1 className="text-3xl md:text-4xl font-bold text-white mb-4 leading-tight">
            Instale o agente em{" "}
            <span className="text-emerald-400">1 comando</span>
          </h1>
          <p className="text-zinc-400 text-sm max-w-xl mx-auto leading-relaxed">
            Sem configuração manual. O agente instala, registra e conecta automaticamente
            ao seu painel em menos de 30 segundos.
          </p>
        </div>

        {/* Cards por plataforma */}
        <div className="grid md:grid-cols-2 gap-6">
          {plataformas.map((p) => (
            <div
              key={p.os}
              className="rounded-2xl border border-zinc-800 bg-zinc-950/60 overflow-hidden"
            >
              {/* Card header */}
              <div className="px-5 py-4 border-b border-zinc-800 flex items-center gap-3">
                <span className="text-xl">{p.icon}</span>
                <div>
                  <h2 className="font-bold text-white text-sm">{p.os}</h2>
                  <p className="text-[11px] text-zinc-600">{p.min}</p>
                </div>
                <span className={`ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full border ${corMap[p.cor]}`}>
                  {p.shell ?? "APK"}
                </span>
              </div>

              {/* Comando */}
              <div className="px-5 pt-4">
                {p.cmd ? (
                  <CopyBox cmd={p.cmd} label={p.shell ?? ""} />
                ) : (
                  <a
                    href={p.apk ?? "#"}
                    className="flex items-center justify-center gap-2 w-full py-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 text-sm font-semibold transition-colors"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    Baixar APK (Android)
                  </a>
                )}
              </div>

              {/* Passos */}
              <div className="px-5 py-4">
                <ol className="space-y-2">
                  {p.passos.map((passo, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-xs text-zinc-400">
                      <span className={`shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold border mt-0.5 ${corMap[p.cor]}`}>
                        {i + 1}
                      </span>
                      {passo}
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          ))}
        </div>

        {/* Token hint */}
        <div className="mt-10 rounded-xl border border-zinc-800 bg-zinc-900/40 px-6 py-5 flex gap-4 items-start">
          <svg className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <div>
            <p className="text-sm font-semibold text-white mb-1">Token de autenticação</p>
            <p className="text-xs text-zinc-400 leading-relaxed">
              No painel, vá em <strong className="text-zinc-200">Máquinas → Cadastrar Máquina</strong> para gerar o token de instalação.
              O instalador usa esse token para autenticar e registrar o agente de forma segura via mTLS.
            </p>
          </div>
        </div>

        {/* Suporte */}
        <p className="text-center text-xs text-zinc-600 mt-10">
          Dúvidas?{" "}
          <Link href="/#contato" className="text-emerald-500 hover:underline">
            Fale com a equipe GMTec
          </Link>
        </p>
      </main>
    </div>
  );
}
