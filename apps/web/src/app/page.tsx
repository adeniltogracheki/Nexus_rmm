import Link from "next/link";

export const metadata = {
  title: "Nexus RMM — Controle total da sua frota de TI",
  description:
    "RMM brasileiro para MSPs: acesso remoto, terminal, inventário, IA com aprovação humana e relatórios. Windows, Linux e macOS. Instale em 1 comando.",
};

// ─── SVG Icons ───────────────────────────────────────────────────────────────

function IconMonitor({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function IconTerminal({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function IconSettings({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function IconActivity({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}

function IconWrench({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function IconBarChart({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}

function IconBuilding({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M9 21V9" />
    </svg>
  );
}

function IconShield({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function IconPackage({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="16.5" y1="9.4" x2="7.5" y2="4.21" />
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}

function IconBrain({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
      <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
      <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
      <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
      <path d="M19.938 10.5a4 4 0 0 1 .585.396" />
      <path d="M6 18a4 4 0 0 1-1.967-.516" />
      <path d="M19.967 17.484A4 4 0 0 1 18 18" />
    </svg>
  );
}

function IconGlobe({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function IconBell({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function IconWhatsApp({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z" />
    </svg>
  );
}

function IconCheck({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function IconArrowRight({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

// ─── Data ─────────────────────────────────────────────────────────────────────

const features = [
  { Icon: IconMonitor,  t: "Acesso remoto nativo",       d: "Tela ao vivo via DXGI (sem VNC), copiar/colar, tela cheia e múltiplos monitores. Sessão autenticada com senha efêmera." },
  { Icon: IconTerminal, t: "Terminal real",               d: "PowerShell, CMD, Bash e sh em tempo real, estilo SSH, direto do navegador. Com copiloto IA para sugestão de comandos." },
  { Icon: IconSettings, t: "Serviços Windows / Linux",   d: "Iniciar/parar/reiniciar serviços, watchdog automático, ações em massa em N máquinas ao mesmo tempo." },
  { Icon: IconActivity, t: "Saúde ao vivo",               d: "CPU, RAM e disco em tempo real, health score com histórico, heatmap de alertas por hora e CVE scanner." },
  { Icon: IconBrain,    t: "IA com aprovação humana",     d: "A IA detecta anomalias, propõe correções e aguarda OK via Telegram, WhatsApp ou painel antes de agir. Zero ação automática sem autorização." },
  { Icon: IconBell,     t: "Alertas Telegram e WhatsApp", d: "Notificações instantâneas de CPU, RAM, disco e máquinas offline. Aprove ou cancele remediações respondendo uma mensagem." },
  { Icon: IconWrench,   t: "Gestão de manutenção",        d: "Peças, técnico, custo, foto + nota fiscal, preventiva agendada com alertas automáticos." },
  { Icon: IconBarChart, t: "Relatórios profissionais",    d: "Operacional, rastreabilidade, inventário e manutenção — com sua marca. Exportação CSV." },
  { Icon: IconBuilding, t: "Portal do cliente",           d: "Cada cliente acessa apenas os equipamentos dele e abre chamados. Revenda como mensalidade." },
  { Icon: IconShield,   t: "Seguro por padrão",           d: "mTLS por máquina, MFA, RBAC, RLS por empresa no banco, auditoria imutável com cadeia de hash." },
  { Icon: IconPackage,  t: "Inventário completo",         d: "Hardware, software, SO, rede e discos de cada ativo — sempre atualizado, com diagnóstico IA." },
  { Icon: IconGlobe,    t: "Multi-plataforma",            d: "Agente para Windows, Linux (Ubuntu, Debian, RHEL, Fedora) e macOS (Intel + Apple Silicon). Instala em 1 comando." },
];

const planos = [
  {
    n: "Trial",
    p: "Grátis",
    sub: "",
    features: ["1 máquina", "Acesso remoto (tela)", "Terminal (PowerShell/Bash)", "Relatórios básicos"],
    cta: "Testar grátis",
    destaque: false,
    badge: null,
  },
  {
    n: "Essencial",
    p: "R$149",
    sub: "/mês",
    features: ["25 máquinas", "Tudo do Trial", "Serviços Windows/Linux", "Arquivos", "Inventário completo", "Alertas Telegram + WhatsApp", "Multi-empresa"],
    cta: "Assinar",
    destaque: false,
    badge: null,
  },
  {
    n: "Pro",
    p: "R$399",
    sub: "/mês",
    features: ["150 máquinas", "Tudo do Essencial", "Relatórios avançados", "Gestão de manutenção", "Scripts e automação", "Portal do cliente", "🤖 IA remediação + aprovação humana"],
    cta: "Assinar",
    destaque: true,
    badge: "MAIS POPULAR",
  },
  {
    n: "Enterprise",
    p: "Sob consulta",
    sub: "",
    features: ["Máquinas ilimitadas", "Tudo do Pro", "Suporte dedicado", "SLA customizado", "Onboarding assistido"],
    cta: "Falar com vendas",
    destaque: false,
    badge: null,
  },
];

const ZAP =
  "https://wa.me/5565984174850?text=" +
  encodeURIComponent("Olá! Quero testar o Nexus RMM.");

// ─── Mock de painel ───────────────────────────────────────────────────────────

function PainelMock() {
  return (
    <div
      className="rounded-xl overflow-hidden border border-emerald-500/20 shadow-[0_0_60px_rgba(16,185,129,0.12)]"
      style={{ background: "#0d0d10", fontFamily: "var(--font-geist-mono)" }}
    >
      {/* Titlebar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/5" style={{ background: "#111115" }}>
        <span className="w-2.5 h-2.5 rounded-full bg-red-500/70"></span>
        <span className="w-2.5 h-2.5 rounded-full bg-amber-500/70"></span>
        <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/70"></span>
        <span className="ml-3 text-[10px] text-zinc-500 uppercase tracking-widest">NEXUS RMM · Dashboard</span>
        <span className="ml-auto flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse-subtle"></span>
          <span className="text-[9px] text-emerald-400">Online</span>
        </span>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-4 gap-px border-b border-white/5" style={{ background: "rgba(255,255,255,0.03)" }}>
        {[
          { v: "18", l: "Máquinas" },
          { v: "16", l: "Online" },
          { v: "2", l: "Offline" },
          { v: "94", l: "Score" },
        ].map(({ v, l }) => (
          <div key={l} className="flex flex-col items-center py-3 px-2" style={{ background: "#0d0d10" }}>
            <span className="text-xl font-bold text-white">{v}</span>
            <span className="text-[9px] text-zinc-500 mt-0.5">{l}</span>
          </div>
        ))}
      </div>

      {/* Aprovação IA */}
      <div className="px-4 py-2.5 border-b border-white/5" style={{ background: "rgba(245,158,11,0.04)" }}>
        <div className="text-[9px] font-semibold text-amber-400 uppercase tracking-widest mb-1.5">⏳ Aprovação IA pendente</div>
        <div className="flex items-center justify-between gap-2">
          <div>
            <span className="text-[10px] text-zinc-300 font-semibold">SERVER-DB-01</span>
            <span className="ml-2 text-[9px] text-zinc-500">CPU 97% · IA propõe limpeza · cod: XF4K92</span>
          </div>
          <div className="flex gap-1 shrink-0">
            <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-[9px] text-emerald-300 font-bold cursor-pointer">SIM</span>
            <span className="px-2 py-0.5 rounded bg-zinc-800 text-[9px] text-zinc-400 cursor-pointer">NÃO</span>
          </div>
        </div>
      </div>

      {/* Alertas */}
      <div className="px-4 py-2.5 border-b border-white/5">
        <div className="text-[9px] font-semibold text-zinc-500 uppercase tracking-widest mb-1.5">Alertas</div>
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse-subtle shrink-0"></span>
            <span className="text-[10px] text-zinc-300">SERVER-WEB</span>
            <span className="ml-auto text-[9px] text-red-400">offline · 2h</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0"></span>
            <span className="text-[10px] text-zinc-300">DESKTOP-01 (🐧)</span>
            <span className="ml-auto text-[9px] text-amber-400">RAM 91%</span>
          </div>
        </div>
      </div>

      {/* Plataformas */}
      <div className="px-4 py-2.5 border-b border-white/5">
        <div className="text-[9px] font-semibold text-zinc-500 uppercase tracking-widest mb-1.5">Plataformas online</div>
        <div className="flex gap-3">
          {[{ e: "🪟", n: "Windows", q: 10 }, { e: "🐧", n: "Linux", q: 4 }, { e: "🍎", n: "macOS", q: 2 }].map(({ e, n, q }) => (
            <div key={n} className="flex items-center gap-1">
              <span className="text-[10px]">{e}</span>
              <span className="text-[9px] text-zinc-400">{n}</span>
              <span className="text-[9px] text-zinc-600 ml-0.5">·{q}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Fake terminal linha */}
      <div className="px-4 py-2" style={{ background: "#09090c" }}>
        <span className="text-[9px] text-emerald-400">$</span>
        <span className="text-[9px] text-zinc-400 ml-1.5">systemctl status nginx | head -5</span>
        <span className="cursor-blink text-[9px] text-emerald-400 ml-0.5">▌</span>
      </div>
    </div>
  );
}

// ─── Landing ──────────────────────────────────────────────────────────────────

export default function Landing() {
  return (
    <div className="min-h-screen text-zinc-200 overflow-x-hidden" style={{ background: "#07070a" }}>

      {/* ── Nav ── */}
      <header
        className="sticky top-0 z-50 border-b border-white/[0.04] transition-all"
        style={{ background: "rgba(7,7,10,0.85)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}
      >
        <nav className="max-w-6xl mx-auto px-5 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="relative">
              <IconMonitor className="w-5 h-5 text-zinc-300" />
              <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-500 border border-[#07070a]"></span>
            </div>
            <span className="font-extrabold text-sm tracking-tight text-white">NEXUS</span>
            <span className="font-light text-sm text-emerald-400 tracking-widest">RMM</span>
          </div>

          <div className="hidden md:flex items-center gap-6 text-sm text-zinc-500">
            <a href="#recursos" className="hover:text-zinc-200 transition-colors">Recursos</a>
            <a href="#ia" className="hover:text-zinc-200 transition-colors">IA</a>
            <a href="#plataformas" className="hover:text-zinc-200 transition-colors">Plataformas</a>
            <a href="#planos" className="hover:text-zinc-200 transition-colors">Planos</a>
          </div>

          <Link
            href="/login"
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg border border-emerald-500/40 text-emerald-400 text-sm font-medium hover:border-emerald-500/70 hover:bg-emerald-500/5 transition-all"
          >
            Entrar <IconArrowRight className="w-3.5 h-3.5" />
          </Link>
        </nav>
      </header>

      {/* ── Hero ── */}
      <section className="max-w-6xl mx-auto px-5 pt-20 pb-24">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div className="animate-fade-in-up">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-emerald-500/20 bg-emerald-500/5 text-xs text-emerald-300 mb-7">
              <span>🇧🇷</span>
              <span>Feito no Brasil · MSPs · Windows · Linux · macOS</span>
            </div>

            <h1 className="text-4xl md:text-5xl font-extrabold leading-tight tracking-tight text-white mb-5">
              Monitore e controle<br />
              toda a TI dos<br />
              <span className="text-emerald-400">seus clientes</span>
            </h1>

            <p className="text-zinc-400 text-lg leading-relaxed mb-8 max-w-lg">
              Acesso remoto, terminal, serviços, IA com aprovação humana,
              alertas Telegram/WhatsApp e relatórios — todas as máquinas num painel só.
            </p>

            <div className="flex flex-wrap gap-3 mb-8">
              <Link
                href="/criar-conta"
                className="flex items-center gap-2 px-6 py-3 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black font-semibold text-sm transition-colors"
              >
                Começar grátis <IconArrowRight className="w-4 h-4" />
              </Link>
              <a
                href="#planos"
                className="px-6 py-3 rounded-lg border border-zinc-700 hover:border-zinc-500 text-zinc-300 font-semibold text-sm transition-colors"
              >
                Ver planos
              </a>
            </div>

            <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-zinc-500">
              <span className="flex items-center gap-1.5"><span className="text-emerald-500">⚡</span> Instala em 1 comando</span>
              <span className="flex items-center gap-1.5"><span className="text-emerald-500">🔒</span> mTLS ponta a ponta</span>
              <span className="flex items-center gap-1.5"><span className="text-emerald-500">🤖</span> IA com aprovação humana</span>
              <span className="flex items-center gap-1.5"><span className="text-emerald-500">📦</span> ~30MB RAM</span>
            </div>
          </div>

          <div className="animate-fade-in-up delay-200 lg:block">
            <PainelMock />
          </div>
        </div>
      </section>

      {/* ── Como funciona ── */}
      <section id="como-funciona" className="max-w-5xl mx-auto px-5 py-20 border-t border-white/[0.04]">
        <h2 className="text-center text-2xl font-bold text-white mb-14">Como funciona</h2>

        <div className="relative flex flex-col md:flex-row items-start gap-8 md:gap-0">
          <div className="hidden md:block absolute top-6 left-[16.66%] right-[16.66%] h-px bg-gradient-to-r from-emerald-500/30 via-emerald-500/60 to-emerald-500/30"></div>
          {[
            {
              n: "01",
              t: "Instalar o agente",
              d: <code className="text-[10px] text-emerald-300 bg-emerald-500/5 border border-emerald-500/15 px-2 py-1 rounded block mt-2 font-mono break-all">irm rmm.gmtec.tec.br/i | iex</code>,
            },
            {
              n: "02",
              t: "Agente conecta",
              d: <p className="text-xs text-zinc-500 mt-2">Em segundos aparece no painel, pronto para monitorar. Windows, Linux ou macOS.</p>,
            },
            {
              n: "03",
              t: "Monitorar, controlar e aprovar",
              d: <p className="text-xs text-zinc-500 mt-2">Acesso remoto, terminal, alertas, IA e relatórios — e você aprova ações via Telegram.</p>,
            },
          ].map(({ n, t, d }) => (
            <div key={n} className="flex-1 flex flex-col items-center text-center px-4 md:px-6">
              <div className="relative z-10 w-12 h-12 rounded-full border border-emerald-500/30 flex items-center justify-center mb-4"
                style={{ background: "rgba(16,185,129,0.08)" }}>
                <span className="text-xs font-bold text-emerald-400 font-mono">{n}</span>
              </div>
              <div className="font-semibold text-white text-sm">{t}</div>
              <div className="max-w-[200px]">{d}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── IA Remediação destaque ── */}
      <section id="ia" className="max-w-6xl mx-auto px-5 py-20 border-t border-white/[0.04]">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-violet-500/30 bg-violet-500/5 text-xs text-violet-300 mb-5">
              🤖 Novo · IA com aprovação humana
            </div>
            <h2 className="text-2xl md:text-3xl font-bold text-white mb-4 leading-tight">
              A IA propõe.<br />
              <span className="text-violet-400">Você aprova.</span><br />
              Só então ela age.
            </h2>
            <p className="text-zinc-400 text-sm leading-relaxed mb-6">
              Quando detecta CPU, RAM ou disco em estado crítico, a IA analisa o contexto,
              propõe até 3 ações seguras e envia uma mensagem com um código de confirmação.
              Você responde <strong className="text-white">SIM XF4K92</strong> no Telegram ou WhatsApp — e ela executa.
              Se não aprovar em 10 minutos, o pedido expira.
            </p>
            <div className="space-y-2 mb-6">
              {[
                "Nenhuma ação automática sem OK do técnico",
                "Aprovação via Telegram, WhatsApp ou painel web",
                "Tudo auditado — quem aprovou, quando, qual canal",
                "Cooldown por máquina (sem spam de alertas)",
              ].map((it) => (
                <div key={it} className="flex items-center gap-2 text-xs text-zinc-400">
                  <span className="text-emerald-400 shrink-0">✓</span>
                  {it}
                </div>
              ))}
            </div>
            <div className="text-xs text-zinc-600">Disponível nos planos Pro e Enterprise</div>
          </div>

          {/* Mock aprovação Telegram */}
          <div className="rounded-xl border border-zinc-800 overflow-hidden" style={{ background: "#0d0d10" }}>
            <div className="px-4 py-2.5 border-b border-white/5 flex items-center gap-2" style={{ background: "#111115" }}>
              <span className="text-[10px] text-zinc-500">✈️ Telegram · Nexus RMM Bot</span>
            </div>
            <div className="p-4 space-y-3">
              {/* Mensagem IA */}
              <div className="bg-zinc-900/80 rounded-xl rounded-tl-sm p-3 text-[11px] text-zinc-300 max-w-[85%]">
                <div className="text-amber-300 font-bold mb-1">⚠️ Nexus RMM — Aprovação Necessária</div>
                <div className="text-zinc-400 space-y-0.5">
                  <p><span className="text-zinc-300">Máquina:</span> SERVER-DB-01</p>
                  <p><span className="text-zinc-300">Problema:</span> CPU 97% por 3 min consecutivos</p>
                  <p className="mt-1"><span className="text-zinc-300">IA propõe:</span></p>
                  <p>• Limpar pasta temporários</p>
                  <p>• Reiniciar Print Spooler</p>
                  <p className="mt-1 font-semibold text-white">Responda SIM XF4K92 para autorizar</p>
                  <p>Responda NÃO XF4K92 para cancelar</p>
                  <p className="text-zinc-600 mt-1">⏰ Expira em 10 minutos</p>
                </div>
              </div>
              {/* Resposta técnico */}
              <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl rounded-tr-sm p-3 text-[11px] text-emerald-200 ml-auto max-w-[60%] text-right">
                SIM XF4K92
              </div>
              {/* Confirmação */}
              <div className="bg-zinc-900/80 rounded-xl rounded-tl-sm p-3 text-[11px] text-zinc-300 max-w-[85%]">
                <div className="text-emerald-400 font-bold mb-1">✅ Aprovado por Telegram</div>
                <p className="text-zinc-400">Executando em SERVER-DB-01...</p>
                <p className="text-zinc-500 text-[10px] mt-1">Resultado em instantes.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Multi-plataforma ── */}
      <section id="plataformas" className="max-w-6xl mx-auto px-5 py-20 border-t border-white/[0.04]">
        <h2 className="text-center text-2xl font-bold text-white mb-3">Um agente para tudo</h2>
        <p className="text-center text-zinc-500 text-sm mb-12">
          Monitore Windows, Linux e macOS no mesmo painel. Instala em 1 comando em qualquer plataforma.
        </p>

        <div className="grid md:grid-cols-3 gap-4">
          {[
            {
              icon: "🪟",
              title: "Windows",
              badge: "PowerShell",
              badgeColor: "bg-blue-500/15 text-blue-300",
              cmd: `iex ((New-Object System.Net.WebClient).DownloadString('https://rmm.gmtec.tec.br/instalar.ps1')); Instalar-Nexus -Token "TOKEN"`,
              details: ["Serviço nativo (NSSM)", "Session 0 compatível", "Node.js 24 dedicado", "Auto-update assinado"],
            },
            {
              icon: "🐧",
              title: "Linux",
              badge: "Ubuntu · Debian · RHEL · Fedora · Arch",
              badgeColor: "bg-orange-500/15 text-orange-300",
              cmd: `curl -sSL https://rmm.gmtec.tec.br/instalar-linux.sh | sudo bash -s -- --token=TOKEN`,
              details: ["Serviço systemd", "Node.js via NodeSource", "Serviços via systemctl", "journalctl para logs"],
            },
            {
              icon: "🍎",
              title: "macOS",
              badge: "Monterey 12+ · Intel + Apple Silicon",
              badgeColor: "bg-zinc-600/40 text-zinc-400",
              cmd: `curl -sSL https://rmm.gmtec.tec.br/instalar-macos.sh | sudo bash -s -- --token=TOKEN`,
              details: ["LaunchDaemon (root)", "Homebrew ou pkg oficial", "arm64 e x64 nativos", "/var/log/ para logs"],
            },
          ].map(({ icon, title, badge, badgeColor, cmd, details }) => (
            <div key={title} className="rounded-xl border border-white/[0.06] hover:border-zinc-700 transition-colors p-5 space-y-4"
              style={{ background: "rgba(15,15,20,0.6)" }}>
              <div className="flex items-center gap-2.5">
                <span className="text-2xl">{icon}</span>
                <div>
                  <div className="font-bold text-white text-sm">{title}</div>
                  <div className={`inline-flex px-2 py-0.5 rounded-full text-[9px] font-semibold mt-0.5 ${badgeColor}`}>{badge}</div>
                </div>
              </div>
              <div className="bg-zinc-950 rounded-lg p-2.5 font-mono text-[10px] text-emerald-300 break-all border border-zinc-800/60">
                {cmd}
              </div>
              <ul className="space-y-1">
                {details.map((d) => (
                  <li key={d} className="flex items-center gap-2 text-[11px] text-zinc-500">
                    <span className="text-emerald-500/70">·</span> {d}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Android/iOS PWA */}
        <div className="mt-6 rounded-xl border border-zinc-800/60 p-5 flex flex-col md:flex-row items-start md:items-center gap-4"
          style={{ background: "rgba(15,15,20,0.4)" }}>
          <div className="text-3xl">📱</div>
          <div className="flex-1">
            <div className="font-bold text-white text-sm mb-1">Android e iOS — Instale como app</div>
            <p className="text-xs text-zinc-500">O painel é uma PWA (Progressive Web App). No Android, abra no Chrome → 3 pontos → <b className="text-zinc-300">Adicionar à tela inicial</b>. No iOS, Safari → Compartilhar → <b className="text-zinc-300">Adicionar à Tela de Início</b>. Abre em tela cheia, sem barra do navegador.</p>
          </div>
          <div className="shrink-0 text-xs text-zinc-600 whitespace-nowrap">Sem loja de app · Instalação imediata</div>
        </div>
      </section>

      {/* ── Recursos ── */}
      <section id="recursos" className="max-w-6xl mx-auto px-5 py-20 border-t border-white/[0.04]">
        <h2 className="text-center text-2xl font-bold text-white mb-3">Tudo que um MSP precisa</h2>
        <p className="text-center text-zinc-500 text-sm mb-12">
          Sem licenças separadas. Cada plano inclui o conjunto completo de ferramentas.
        </p>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {features.map(({ Icon, t, d }) => (
            <div
              key={t}
              className="group p-5 rounded-xl border border-white/[0.06] hover:border-emerald-500/30 transition-colors"
              style={{ background: "rgba(15,15,20,0.6)" }}
            >
              <div className="w-8 h-8 rounded-lg flex items-center justify-center mb-4 text-emerald-400"
                style={{ background: "rgba(16,185,129,0.1)" }}>
                <Icon className="w-4 h-4" />
              </div>
              <div className="font-semibold text-white text-sm mb-1.5">{t}</div>
              <p className="text-zinc-500 text-xs leading-relaxed">{d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Planos ── */}
      <section id="planos" className="max-w-6xl mx-auto px-5 py-20 border-t border-white/[0.04]">
        <h2 className="text-center text-2xl font-bold text-white mb-2">Planos</h2>
        <p className="text-center text-zinc-500 text-sm mb-12">Comece grátis. Faça upgrade quando crescer.</p>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {planos.map((pl) => (
            <div
              key={pl.n}
              className={`relative flex flex-col rounded-xl p-5 border transition-colors ${
                pl.destaque
                  ? "border-emerald-500/40 shadow-[0_0_40px_rgba(16,185,129,0.12)]"
                  : "border-white/[0.06] hover:border-white/[0.12]"
              }`}
              style={{ background: pl.destaque ? "rgba(16,185,129,0.04)" : "rgba(15,15,20,0.6)" }}
            >
              {pl.badge && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full bg-emerald-500 text-black text-[10px] font-bold tracking-widest whitespace-nowrap">
                  {pl.badge}
                </div>
              )}
              <div className="text-xs font-semibold text-zinc-400 uppercase tracking-widest mb-3">{pl.n}</div>
              <div className="mb-4">
                <span className="text-3xl font-extrabold text-white">{pl.p}</span>
                {pl.sub && <span className="text-sm text-zinc-500 ml-1">{pl.sub}</span>}
              </div>
              <ul className="space-y-2 mb-6 flex-1">
                {pl.features.map((f) => (
                  <li key={f} className={`flex items-start gap-2 text-xs ${f.startsWith("🤖") ? "text-violet-300" : "text-zinc-400"}`}>
                    <span className={`mt-0.5 shrink-0 ${f.startsWith("🤖") ? "text-violet-400" : "text-emerald-500"}`}>
                      {f.startsWith("🤖") ? "★" : <IconCheck />}
                    </span>
                    {f.startsWith("🤖") ? f.slice(3) : f}
                  </li>
                ))}
              </ul>
              {pl.n === "Enterprise" ? (
                <a
                  href={ZAP} target="_blank" rel="noreferrer"
                  className="text-center px-4 py-2.5 rounded-lg text-sm font-semibold border border-zinc-700 hover:border-zinc-500 text-zinc-300 transition-colors"
                >
                  {pl.cta}
                </a>
              ) : (
                <Link
                  href="/criar-conta"
                  className={`text-center px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors ${
                    pl.destaque
                      ? "bg-emerald-500 hover:bg-emerald-400 text-black"
                      : "border border-zinc-700 hover:border-zinc-500 text-zinc-300"
                  }`}
                >
                  {pl.cta}
                </Link>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── CTA Final ── */}
      <section className="max-w-3xl mx-auto px-5 py-20 text-center border-t border-white/[0.04]">
        <h2 className="text-3xl font-bold text-white mb-3">Pronto para assumir o controle?</h2>
        <p className="text-zinc-400 mb-8">Teste grátis agora. Sem cartão. Sem complicação.</p>
        <div className="flex flex-wrap gap-3 justify-center">
          <Link
            href="/criar-conta"
            className="flex items-center gap-2 px-6 py-3 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black font-semibold text-sm transition-colors"
          >
            Criar conta grátis <IconArrowRight className="w-4 h-4" />
          </Link>
          <a
            href={ZAP} target="_blank" rel="noreferrer"
            className="flex items-center gap-2 px-6 py-3 rounded-lg border border-zinc-700 hover:border-zinc-500 text-zinc-300 font-semibold text-sm transition-colors"
          >
            <IconWhatsApp className="w-4 h-4 text-green-400" />
            Falar no WhatsApp
          </a>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-white/[0.04] py-8">
        <div className="max-w-6xl mx-auto px-5 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-zinc-600">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <IconMonitor className="w-4 h-4 text-zinc-600" />
              <span className="absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-500/60"></span>
            </div>
            <span className="font-semibold text-zinc-500">NEXUS RMM</span>
            <span>·</span><span>© 2025 GMTec</span>
            <span>·</span><span>Cuiabá, MT</span>
            <span>·</span><span>Feito no Brasil 🇧🇷</span>
            <span>·</span><span>Windows · Linux · macOS</span>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/login" className="hover:text-zinc-400 transition-colors">Entrar no painel</Link>
            <Link href="/criar-conta" className="hover:text-zinc-400 transition-colors">Criar conta</Link>
            <a href={ZAP} target="_blank" rel="noreferrer" className="hover:text-zinc-400 transition-colors">WhatsApp</a>
          </div>
        </div>
      </footer>

      {/* ── Botão flutuante WhatsApp ── */}
      <a
        href={ZAP} target="_blank" rel="noreferrer" title="Suporte via WhatsApp"
        className="fixed bottom-5 right-5 z-50 flex items-center gap-2 px-4 py-2.5 rounded-full font-semibold text-sm text-black transition-all hover:scale-105 active:scale-95"
        style={{ background: "#22c55e", boxShadow: "0 0 20px rgba(34,197,94,0.45)" }}
      >
        <IconWhatsApp className="w-4 h-4" />
        Suporte
      </a>
    </div>
  );
}
