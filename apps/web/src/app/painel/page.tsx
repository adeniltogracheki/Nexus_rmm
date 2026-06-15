"use client";

import React, { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { io, Socket } from "socket.io-client";
import "xterm/css/xterm.css";
import Sidebar from "@/components/painel/Sidebar";
import Header from "@/components/painel/Header";
import KpiCard from "@/components/painel/KpiCard";
import BottomNav from "@/components/painel/BottomNav";
import MobileMenu from "@/components/painel/MobileMenu";

interface Maquina {
  id: string;
  hostname: string;
  fingerprint: string;
  soVersao: string | null;
  versaoAgente: string | null;
  online: boolean;
  responsavel?: string | null;
  cpu?: number | null;
  ram?: number | null;
  saude?: "ok" | "alerta" | "critico" | "offline";
  vistoEm: string | null;
  criadoEm: string;
  grupoId: string | null;
  tipoMaquina: "pc" | "notebook" | "servidor" | "mobile" | "tablet";
  apelido: string | null;
  tags?: string[] | null;
  healthScore?: number | null;
  tendenciaScore?: "melhorando" | "estavel" | "piorando" | null;
  criticidade?: "operacional" | "importante" | "critico" | "missao_critica" | null;
  iaRemediacao?: boolean | null;
  iaAcoesPermitidas?: string[] | null;
  macAddress?: string | null;
  ipPublico?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  precisaoMetros?: number | null;
  localizacaoEm?: string | null;
}

interface Grupo {
  id: string;
  nome: string;
  tipo: "empresa" | "departamento";
  parentId: string | null;
}

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
  acesso?: { plano: string; bloqueado: boolean; motivo: "trial" | "vencido" | null; vencimento: string | null; diasRestantes: number };
}

interface MonitorInfo {
  idx: number;
  w: number;
  h: number;
  x: number;
  y: number;
}

// Lista de permissões (capabilities) — espelha o backend (permissoes.ts).
const CAPS_LABEL: Record<string, string> = {
  ver_maquinas: "Ver máquinas",
  acesso_remoto: "Acesso remoto (tela)",
  terminal: "Terminal",
  servicos: "Serviços do Windows",
  arquivos: "Arquivos",
  inventario: "Ficha técnica / inventário",
  metricas: "Métricas / gráficos",
  relatorios: "Relatórios",
  agendador: "Agendador de tarefas",
  chamados: "Chamados",
  usuarios: "Gerir usuários e permissões",
  empresas: "Gerir empresas",
  seguranca: "Painel de segurança",
};
const CAPS_LISTA = Object.keys(CAPS_LABEL);

function HealthBadge({ score, tendencia }: { score: number | null; tendencia?: string | null }) {
  if (score == null) return null;
  const cor = score >= 80 ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
            : score >= 60 ? "text-amber-400 border-amber-500/30 bg-amber-500/10"
            : score >= 40 ? "text-orange-400 border-orange-500/30 bg-orange-500/10"
            :               "text-red-400 border-red-500/30 bg-red-500/10";
  const seta = tendencia === "melhorando" ? "↑" : tendencia === "piorando" ? "↓" : "";
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border text-xs font-mono font-bold ${cor}`}>
      {score}{seta && <span className="text-[10px]">{seta}</span>}
    </span>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserMe | null>(null);
  const [maquinasList, setMaquinasList] = useState<Maquina[]>([]);
  const [secao, setSecao] = useState<"dashboard" | "maquinas" | "empresas" | "relatorios" | "seguranca" | "planos" | "tenants" | "docs">("dashboard");
  const [planoInfo, setPlanoInfo] = useState<any | null>(null);
  const [tenantsList, setTenantsList] = useState<any[] | null>(null);
  const [resumoPlataforma, setResumoPlataforma] = useState<any | null>(null);
  const [novoTenant, setNovoTenant] = useState<any>({ nome: "", ownerEmail: "", ownerSenha: "", plano: "trial" });
  const [segConfig, setSegConfig] = useState<{ apenasBrasil: boolean; forcar2fa: boolean; nomeMarca?: string; logoUrl?: string }>({ apenasBrasil: false, forcar2fa: false, nomeMarca: "", logoUrl: "" });
  const [invConsolidado, setInvConsolidado] = useState<any[] | null>(null);
  const [uptimeDados, setUptimeDados] = useState<any[] | null>(null);
  const [chamadosAbertos, setChamadosAbertos] = useState(0);
  const [empresaFoco, setEmpresaFoco] = useState<string | null>(null);
  const [vistaUsuarios, setVistaUsuarios] = useState(false);
  const [notifCfg, setNotifCfg] = useState<any>({ webhookUrl: "", formato: "generico", telegramChatId: "", minSeveridade: "aviso", ativo: false, relatorioSemanal: false, emailAtivo: false, smtpHost: "", smtpPort: 587, smtpSeguro: true, smtpUser: "", smtpPass: "", smtpFrom: "", emailDestinatarios: "", smtpDefinida: false });
  const [tgCfg, setTgCfg] = useState<any>({ telegramAtivo: false, telegramBotToken: "", telegramChatIdBot: "", notifCritico: true, notifAviso: false, notifOffline: true });
  const [tgCarregado, setTgCarregado] = useState(false);
  const [salvandoTg, setSalvandoTg] = useState(false);
  const [testeTgMsg, setTesteTgMsg] = useState<{tipo:"ok"|"erro";texto:string}|null>(null);
  const [regrasAlerta, setRegrasAlerta] = useState<any>({ cpuLimitePct: 90, cpuJanelaMin: 2, ramLimitePct: 90, ramJanelaMin: 2, discoLivreMinPct: 10, iaRemediaCaoGlobal: false });
  const [regrasCarregadas, setRegrasCarregadas] = useState(false);
  const [salvandoRegras, setSalvandoRegras] = useState(false);
  const [iaCatalogo, setIaCatalogo] = useState<Array<{id:string;desc:string}>>([]);
  const [remediacoesLog, setRemediacoesLog] = useState<any[]>([]);
  const [remediacoesCarregadas, setRemediacoesCarregadas] = useState(false);
  const [salvandoIaMaq, setSalvandoIaMaq] = useState(false);
  const [aprovacoesPendentes, setAprovacoesPendentes] = useState<any[]>([]);
  const [aprovWh, setAprovWh] = useState<Record<string, boolean>>({});
  const [regTgMsg, setRegTgMsg] = useState<{tipo:"ok"|"erro";texto:string}|null>(null);
  const [regWaMsg, setRegWaMsg] = useState<{tipo:"ok"|"erro";texto:string}|null>(null);
  const [usuariosList, setUsuariosList] = useState<any[]>([]);
  const [novoUserEmail, setNovoUserEmail] = useState("");
  const [novoUserSenha, setNovoUserSenha] = useState("");
  const [novoUserPapel, setNovoUserPapel] = useState("operator");
  const [vistaTarefas, setVistaTarefas] = useState(false);
  const [tarefasList, setTarefasList] = useState<any[]>([]);
  const [tarefaMaquina, setTarefaMaquina] = useState("");
  const [tarefaNome, setTarefaNome] = useState("");
  const [tarefaComando, setTarefaComando] = useState("");
  const [tarefaFreq, setTarefaFreq] = useState("diaria");
  const [tarefaHorario, setTarefaHorario] = useState("03:00");
  const [tarefaDataUnica, setTarefaDataUnica] = useState("");
  const [vistaChamados, setVistaChamados] = useState(false);
  const [chamadosList, setChamadosList] = useState<any[]>([]);
  const [chamadoSel, setChamadoSel] = useState<any | null>(null);
  const [modoNovoChamado, setModoNovoChamado] = useState(false);
  const [novoTitulo, setNovoTitulo] = useState("");
  const [novoDesc, setNovoDesc] = useState("");
  const [novoPrioridade, setNovoPrioridade] = useState("media");
  const [novoMaquinaId, setNovoMaquinaId] = useState("");
  const [comentarioTexto, setComentarioTexto] = useState("");
  const [alertasList, setAlertasList] = useState<any[]>([]);
  const [alertasNaoLidas, setAlertasNaoLidas] = useState(0);
  const [mostrarAlertas, setMostrarAlertas] = useState(false);
  const [selecionadas, setSelecionadas] = useState<Set<string>>(new Set());
  const [servicoMassa, setServicoMassa] = useState("");
  const [executandoMassa, setExecutandoMassa] = useState(false);
  // Comando em lote
  const [loteAba, setLoteAba] = useState<"servico" | "comando">("servico");
  const [comandoLote, setComandoLote] = useState("");
  const [executandoLote, setExecutandoLote] = useState(false);
  const [resultadosLote, setResultadosLote] = useState<Array<{ maquinaId: string; hostname: string; ok: boolean; saida: string }> | null>(null);
  // Command palette (Ctrl+K)
  const [paletteAberta, setPaletteAberta] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIdx, setPaletteIdx] = useState(0);
  const paletteInputRef = useRef<HTMLInputElement>(null);
  const [carregando, setCarregando] = useState(true);
  const [socketConectado, setSocketConectado] = useState(false);
  
  // Modal de cadastro
  const [modalAberto, setModalAberto] = useState(false);
  const [tokenGerado, setTokenGerado] = useState("");
  const [gerandoToken, setGerandoToken] = useState(false);
  const [copiouToken, setCopiouToken] = useState(false);
  const [mostrarToken, setMostrarToken] = useState(false);
  const [copiouComando, setCopiouComando] = useState(false);
  const [copiouLinux, setCopiouLinux] = useState(false);
  const [copiouMac, setCopiouMac] = useState(false);
  const [copiouAndroid, setCopiouAndroid] = useState(false);

  // Mobile menu drawer
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Acesso à tela (não supervisionado)
  const [abrindoTela, setAbrindoTela] = useState<string | null>(null);
  const [enviandoWol, setEnviandoWol] = useState<string | null>(null);
  const [telaUrl, setTelaUrl] = useState<string | null>(null);
  const [telaNome, setTelaNome] = useState<string>("");
  const [monitoresMaquina, setMonitoresMaquina] = useState<MonitorInfo[]>([]);
  const [monitorIdx, setMonitorIdx] = useState<number>(0);
  const [maquinaTelaId, setMaquinaTelaId] = useState<string | null>(null);
  const [promptCfg, setPromptCfg] = useState<{ titulo: string; valor: string; resolve: (v: string | null) => void } | null>(null);
  const [novaTag, setNovaTag] = useState("");
  const [colW, setColW] = useState<Record<string, number>>({});
  const [filtroTag, setFiltroTag] = useState<string | null>(null);
  const [filtroSO, setFiltroSO] = useState<"windows" | "linux" | "macos" | null>(null);
  const [asideEmpresas, setAsideEmpresas] = useState(true);
  const [busca, setBusca] = useState("");

  // Versão de produção do agente (para badge de atualização)
  const [versaoProd, setVersaoProd] = useState<string | null>(null);
  const [atualizandoMaquinaId, setAtualizandoMaquinaId] = useState<string | null>(null);
  const [atualizandoLoteGrupo, setAtualizandoLoteGrupo] = useState<string | null>(null); // grupoId ou "all"
  const [updateMsg, setUpdateMsg] = useState<{ id: string; tipo: "ok" | "erro"; texto: string } | null>(null);

  // Grupos (empresas/departamentos) + filtro
  const [gruposList, setGruposList] = useState<Grupo[]>([]);
  const [grupoSelecionado, setGrupoSelecionado] = useState<string | null>(null);

  // Gerenciamento de Serviços e Inventário
  const [maquinaServicos, setMaquinaServicos] = useState<Maquina | null>(null);
  const [abaAtiva, setAbaAtiva] = useState<"visao" | "servicos" | "inventario" | "logs" | "terminal" | "arquivos" | "manutencao">("visao");
  const [manutList, setManutList] = useState<any[] | null>(null);
  const [novaManut, setNovaManut] = useState<any>({ tipo: "corretiva", descricao: "", pecasTrocadas: "", tecnico: "", custo: "", proximaPreventiva: "" });
  const [respEdit, setRespEdit] = useState("");
  const [caminhoArq, setCaminhoArq] = useState("");
  const [arquivosItens, setArquivosItens] = useState<any[]>([]);
  const [carregandoArq, setCarregandoArq] = useState(false);
  const [comandoShell, setComandoShell] = useState("");
  const [saidaShell, setSaidaShell] = useState("");
  const [executandoShell, setExecutandoShell] = useState(false);

  // Terminal interativo (Xterm.js)
  const [terminalSessionId, setTerminalSessionId] = useState<string>("");
  const [terminalStatus, setTerminalStatus] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const [copilotInput, setCopilotInput] = useState("");
  const [copilotPreview, setCopilotPreview] = useState<{ comando: string; explicacao: string } | null>(null);
  const [copilotCarregando, setCopilotCarregando] = useState(false);
  const [copilotAtivo, setCopilotAtivo] = useState(false);
  const [activeShellType, setActiveShellType] = useState<"powershell" | "cmd">("powershell");
  const [terminalFull, setTerminalFull] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const xtermInstanceRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  const terminalSessionIdRef = useRef<string>("");
  const copilotEncodingInitializedRef = useRef<boolean>(false); // UTF-8 já configurado para esta sessão

  // Captura de sessão terminal para resumo automático
  const terminalTranscriptRef = useRef<string[]>([]);   // comandos executados
  const terminalLineBufferRef = useRef<string>("");     // linha atual sendo digitada
  const terminalStartedAtRef = useRef<number>(0);       // timestamp de início da sessão
  const terminalMaquinaIdRef = useRef<string>("");      // maquinaId da sessão ativa

  // Toast do resumo da sessão
  const [resumoSessao, setResumoSessao] = useState<{
    resumo: string;
    categoria: string;
    manutencaoId: string | null;
    semIA: boolean;
    visivel: boolean;
  } | null>(null);

  async function gerarResumoTerminal(maqId: string, shell: string) {
    const comandos = [...terminalTranscriptRef.current];
    const duracaoSegundos = terminalStartedAtRef.current
      ? Math.round((Date.now() - terminalStartedAtRef.current) / 1000)
      : 0;

    // Limpar buffers
    terminalTranscriptRef.current = [];
    terminalLineBufferRef.current = "";
    terminalStartedAtRef.current = 0;

    if (comandos.length === 0) return; // nada para resumir

    try {
      const r = await fetch("/api/terminal/resumo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maquinaId: maqId, comandos, duracaoSegundos, shell }),
      });
      if (!r.ok) return;
      const d = await r.json();
      setResumoSessao({
        resumo: d.resumo,
        categoria: d.categoria,
        manutencaoId: d.manutencaoId,
        semIA: d.semIA,
        visivel: true,
      });
      // Auto-oculta após 12 segundos
      setTimeout(() => setResumoSessao((prev) => prev ? { ...prev, visivel: false } : null), 12000);
    } catch {
      // silencioso — o resumo é bônus, não crítico
    }
  }
  const [servicos, setServicos] = useState<any[]>([]);
  const [carregandoServicos, setCarregandoServicos] = useState(false);
  const [filtroServicos, setFiltroServicos] = useState("");
  const [executandoAcao, setExecutandoAcao] = useState<string | null>(null);

  // Ficha técnica / Inventário
  const [inventario, setInventario] = useState<any | null>(null);
  const [metricas, setMetricas] = useState<any>(null);
  const [histMetricas, setHistMetricas] = useState<any[]>([]);
  const [carregandoInventario, setCarregandoInventario] = useState(false);
  const [discosPrevisao, setDiscosPrevisao] = useState<any[]>([]);
  const [filtroSoftware, setFiltroSoftware] = useState("");
  const [desinstalando, setDesinstalando] = useState<string | null>(null);

  // CVE Scanner
  interface CveVuln {
    software: string;
    versao: string;
    risco: "critico" | "alto" | "medio" | "baixo";
    descricao: string;
    cve: string | null;
    recomendacao: string;
  }
  interface CveResultado {
    vulnerabilidades: CveVuln[];
    resumo: string;
    total: number;
    criticos: number;
    altos: number;
    geradoEm: string;
    semIA: boolean;
    cached?: boolean;
  }
  const [cveResultado, setCveResultado] = useState<CveResultado | null>(null);
  const [cveScanCarregando, setCveScanCarregando] = useState(false);
  const [cveExpandido, setCveExpandido] = useState(true);

  async function executarCveScan(maqId: string, forcar = false) {
    setCveScanCarregando(true);
    if (forcar) setCveResultado(null);
    try {
      const r = await fetch(`/api/maquinas/${maqId}/vulnerabilidades${forcar ? "?forcar=true" : ""}`, { method: "POST" });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.erro || `HTTP ${r.status}`);
      }
      const d = await r.json();
      setCveResultado(d);
      setCveExpandido(true);
    } catch (err: any) {
      mostrarToast(`Erro no CVE Scanner: ${err.message}`, "erro");
    } finally {
      setCveScanCarregando(false);
    }
  }

  // Histórico de logs da máquina
  const [logs, setLogs] = useState<any[]>([]);
  const [carregandoLogs, setCarregandoLogs] = useState(false);
  const [filtroLogsStatus, setFiltroLogsStatus] = useState("");

  // Relatórios analíticos do Tenant
  const [resumoRelatorios, setResumoRelatorios] = useState<any | null>(null);
  const [relAba, setRelAba] = useState<"operacional" | "auditoria" | "inventario" | "manutencoes" | "sla">("operacional");
  const [manutReport, setManutReport] = useState<{ recentes: any[]; preventivas: any[]; custoTotal?: number; custos?: any[] } | null>(null);
  const [relEmpresa, setRelEmpresa] = useState<string>("");
  const [auditoria, setAuditoria] = useState<{ total: number; itens: any[]; pagina: number; limite: number } | null>(null);
  const [audFiltros, setAudFiltros] = useState<{ de: string; ate: string; maquinaId: string; status: string; q: string }>({ de: "", ate: "", maquinaId: "", status: "", q: "" });
  const [audPagina, setAudPagina] = useState(0);
  const [carregandoAud, setCarregandoAud] = useState(false);

  // G) SLA de disponibilidade
  const [slaDados, setSlaDados] = useState<{ dias: number; empresas: any[]; total: number } | null>(null);
  const [slaDias, setSlaDias] = useState(30);
  const [carregandoSla, setCarregandoSla] = useState(false);

  // A) Health Score histórico por máquina (sparkline 7 dias)
  const [healthHistory, setHealthHistory] = useState<{ data: string; score: number; cpu: number | null; ram: number | null }[] | null>(null);
  const [carregandoHealthHistory, setCarregandoHealthHistory] = useState(false);

  // B) Heatmap de alertas por hora
  const [alertHeatmap, setAlertHeatmap] = useState<{ horas: Record<number, { total: number; criticos: number; avisos: number }>; maxTotal: number } | null>(null);
  const [carregandoHeatmap, setCarregandoHeatmap] = useState(false);

  // H) Process Scan (malware patterns)
  const [processScan, setProcessScan] = useState<{ ameacas: any[]; total: number; criticos: number; processosAnalisados: number; geradoEm: string; modoAnalise: string } | null>(null);
  const [carregandoProcessScan, setCarregandoProcessScan] = useState(false);

  // D) Auto-remediação
  const [remediandoMaquina, setRemediandoMaquina] = useState(false);
  const [remediacaoResultado, setRemediacaoResultado] = useState<{ ok: boolean; resultados: { acao: string; output: string; ok: boolean }[] } | null>(null);

  // I) Audit Trail por máquina
  const [auditTrail, setAuditTrail] = useState<{ eventos: any[]; total: number } | null>(null);
  const [carregandoAuditTrail, setCarregandoAuditTrail] = useState(false);

  // E) WhatsApp config
  const [waCfg, setWaCfg] = useState<{ ativo: boolean; apiUrl: string; instancia: string; apiKey: string; numero: string; alertaCritico: boolean; alertaOffline: boolean } | null>(null);
  const [salvandoWa, setSalvandoWa] = useState(false);
  const [testandoWa, setTestandoWa] = useState(false);
  const [waMensagem, setWaMensagem] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);

  // Toast notifications — sistema centralizado (substitui alert())
  const [toasts, setToasts] = useState<Array<{ id: string; msg: string; tipo: "ok" | "erro" | "info" | "aviso" }>>([]);

  // Briefing IA — parágrafo de saúde da infra no topo do dashboard
  const [briefing, setBriefing] = useState<string | null>(null);
  const [briefingCarregando, setBriefingCarregando] = useState(false);

  // Saúde do servidor RMM (host)
  interface ServerHealth {
    timestamp: string;
    cpu: { modelo: string; nucleos: number; usoPct: number; loadAvg: { m1: number; m5: number; m15: number } };
    ram: { totalGB: number; usadoGB: number; livreGB: number; usoPct: number };
    disco: { totalGB: number; usadoGB: number; livreGB: number; usoPct: number };
    uptime: { segundos: number; texto: string };
    processo: { heapUsadoMB: number; heapTotalMB: number; rssMB: number; uptimeS: number };
    redis: { memHuman: string; conexoes: number };
  }
  const [serverHealth, setServerHealth] = useState<ServerHealth | null>(null);
  const [serverHealthCarregando, setServerHealthCarregando] = useState(false);
  const serverHealthTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function carregarServerHealth() {
    setServerHealthCarregando(true);
    try {
      const r = await fetch("/api/admin/server-health");
      if (r.ok) setServerHealth(await r.json());
    } catch {} finally {
      setServerHealthCarregando(false);
    }
  }

  // Diagnóstico IA — modal por máquina
  interface DiagnosticoResult {
    severidade: "critica" | "alta" | "media" | "baixa";
    causa: string;
    acoes: string[];
    geradoEm: string;
    cached?: boolean;
    semIA?: boolean;
  }
  const [diagnosticoModal, setDiagnosticoModal] = useState<{
    maquinaId: string;
    estado: "carregando" | "resultado" | "erro";
    resultado?: DiagnosticoResult;
    erro?: string;
  } | null>(null);

  async function executarDiagnostico(maqId: string, forcar = false) {
    setDiagnosticoModal({ maquinaId: maqId, estado: "carregando" });
    try {
      const r = await fetch(`/api/maquinas/${maqId}/diagnostico${forcar ? "?forcar=true" : ""}`, { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setDiagnosticoModal({ maquinaId: maqId, estado: "resultado", resultado: d });
    } catch (err: any) {
      setDiagnosticoModal({ maquinaId: maqId, estado: "erro", erro: err.message || "Erro desconhecido" });
    }
  }

  async function carregarAuditoria(pagina = 0) {
    setCarregandoAud(true);
    try {
      const p = new URLSearchParams();
      if (audFiltros.de) p.set("de", new Date(audFiltros.de).toISOString());
      if (audFiltros.ate) p.set("ate", new Date(audFiltros.ate + "T23:59:59").toISOString());
      if (audFiltros.maquinaId) p.set("maquinaId", audFiltros.maquinaId);
      if (audFiltros.status) p.set("status", audFiltros.status);
      if (audFiltros.q) p.set("q", audFiltros.q);
      p.set("pagina", String(pagina));
      const r = await fetch(`/api/relatorios/auditoria?${p.toString()}`);
      if (r.ok) { setAuditoria(await r.json()); setAudPagina(pagina); }
    } catch {} finally { setCarregandoAud(false); }
  }

  async function carregarManutReport() {
    try { const r = await fetch("/api/relatorios/manutencoes"); if (r.ok) setManutReport(await r.json()); } catch {}
  }
  function exportarManutCsv() {
    const linhas = [["Data", "Maquina", "Tipo", "Descricao", "Pecas", "Tecnico", "Custo", "Proxima_Preventiva"]];
    for (const m of manutReport?.recentes || []) {
      linhas.push([new Date(m.data).toLocaleDateString(), m.apelido || m.hostname || "", m.tipo || "", m.descricao || "", m.pecas || "", m.tecnico || "", m.custo || "", m.proxima ? new Date(m.proxima).toLocaleDateString() : ""]);
    }
    const csv = linhas.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `manutencoes-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
  }

  async function carregarUptime() {
    try {
      const r = await fetch("/api/relatorios/uptime?dias=30");
      if (r.ok) { const j = await r.json(); setUptimeDados(j.itens || []); }
    } catch {}
  }

  async function carregarInvConsolidado() {
    try {
      const r = await fetch("/api/relatorios/inventario");
      if (r.ok) { const j = await r.json(); setInvConsolidado(j.itens || []); }
    } catch {}
  }

  // G) SLA
  async function carregarSla(dias = slaDias) {
    setCarregandoSla(true);
    try {
      const r = await fetch(`/api/relatorios/sla?dias=${dias}`);
      if (r.ok) setSlaDados(await r.json());
    } catch {} finally { setCarregandoSla(false); }
  }

  // A) Health history sparkline
  async function carregarHealthHistory(maqId: string) {
    setCarregandoHealthHistory(true);
    setHealthHistory(null);
    try {
      const r = await fetch(`/api/maquinas/${maqId}/health-history`);
      if (r.ok) { const d = await r.json(); setHealthHistory(d.pontos); }
    } catch {} finally { setCarregandoHealthHistory(false); }
  }

  // B) Heatmap
  async function carregarHeatmap() {
    setCarregandoHeatmap(true);
    try {
      const r = await fetch("/api/dashboard/alert-heatmap");
      if (r.ok) setAlertHeatmap(await r.json());
    } catch {} finally { setCarregandoHeatmap(false); }
  }

  // H) Process scan
  async function executarProcessScan(maqId: string) {
    setCarregandoProcessScan(true);
    setProcessScan(null);
    try {
      const r = await fetch(`/api/maquinas/${maqId}/process-scan`, { method: "POST" });
      if (r.ok) setProcessScan(await r.json());
      else { const d = await r.json().catch(() => ({})); mostrarToast(`Erro: ${(d as any).erro || r.status}`, "erro"); }
    } catch (e: any) { mostrarToast(`Erro: ${e.message}`, "erro"); } finally { setCarregandoProcessScan(false); }
  }

  // D) Auto-remediação
  async function executarRemediacao(maqId: string) {
    if (!confirm("Executar limpeza automática nesta máquina?\n\n• Limpar pasta TEMP\n• Limpar cache DNS\n• Reiniciar serviços automáticos parados\n\nEsta ação é reversível.")) return;
    setRemediandoMaquina(true);
    setRemediacaoResultado(null);
    try {
      const r = await fetch(`/api/maquinas/${maqId}/auto-remediate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acoes: ["temp", "cache_dns", "servicos"] }),
      });
      if (r.ok) setRemediacaoResultado(await r.json());
      else { const d = await r.json().catch(() => ({})); mostrarToast(`Erro: ${(d as any).erro || r.status}`, "erro"); }
    } catch (e: any) { mostrarToast(`Erro: ${e.message}`, "erro"); } finally { setRemediandoMaquina(false); }
  }

  // F) Reiniciar serviço do agente Nexus na máquina
  async function reiniciarAgente(maqId: string) {
    if (!confirm("Reiniciar o serviço nexus-agente nesta máquina?\n\nO agente ficará offline por alguns segundos e reconectará automaticamente.")) return;
    try {
      const cmd = `sc stop nexus-agente 2>$null; Start-Sleep 2; sc start nexus-agente 2>$null; Write-Output 'Reiniciando...'`;
      const r = await fetch(`/api/maquinas/${maqId}/shell`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd, shell: "powershell" }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) mostrarToast("Agente reiniciando — reconectará em segundos.", "ok");
      else mostrarToast(`Erro: ${(j as any).erro || r.status}`, "erro");
    } catch (e: any) { mostrarToast(`Erro: ${e.message}`, "erro"); }
  }

  // I) Audit trail por máquina
  async function carregarAuditTrail(maqId: string) {
    setCarregandoAuditTrail(true);
    setAuditTrail(null);
    try {
      const r = await fetch(`/api/maquinas/${maqId}/audit-trail`);
      if (r.ok) setAuditTrail(await r.json());
    } catch {} finally { setCarregandoAuditTrail(false); }
  }

  // E) Carregar e salvar config WhatsApp
  async function carregarWaCfg() {
    try {
      const r = await fetch("/api/config/whatsapp");
      if (r.ok) setWaCfg(await r.json());
    } catch {}
  }
  async function salvarWaCfg() {
    if (!waCfg) return;
    setSalvandoWa(true);
    try {
      const r = await fetch("/api/config/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(waCfg),
      });
      if (r.ok) setWaMensagem({ tipo: "ok", texto: "Configuração salva com sucesso!" });
      else setWaMensagem({ tipo: "erro", texto: "Erro ao salvar — verifique se o MFA está ativo." });
    } catch (e: any) { setWaMensagem({ tipo: "erro", texto: e.message }); } finally { setSalvandoWa(false); }
  }
  async function testarWa() {
    setTestandoWa(true);
    try {
      const r = await fetch("/api/config/whatsapp/test", { method: "POST" });
      const d = await r.json() as { ok?: boolean; erro?: string };
      if (d.ok) setWaMensagem({ tipo: "ok", texto: "Mensagem de teste enviada com sucesso!" });
      else setWaMensagem({ tipo: "erro", texto: d.erro || "Falha ao enviar" });
    } catch (e: any) { setWaMensagem({ tipo: "erro", texto: e.message }); } finally { setTestandoWa(false); }
  }

  function exportarInvCsv() {
    const linhas = [["Maquina", "Status", "Tipo", "SO", "CPU", "RAM_GB", "Disco_Total_GB", "Disco_Livre_GB", "Softwares"]];
    for (const i of invConsolidado || []) {
      linhas.push([i.apelido || i.hostname || "", i.online ? "Online" : "Offline", i.tipo || "", i.so || "", i.cpu || "", String(i.ramGB ?? ""), String(i.discoTotalGB ?? ""), String(i.discoLivreGB ?? ""), String(i.softwares ?? "")]);
    }
    const csv = linhas.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `inventario-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  function exportarAuditoriaCsv() {
    const linhas = [["Quando", "Usuario", "Maquina", "Tipo", "Acao", "Status", "Detalhe"]];
    for (const a of auditoria?.itens || []) {
      linhas.push([new Date(a.em).toLocaleString(), a.usuario || "", a.apelido || a.hostname || "", a.tipo || "", a.acao || "", a.status || "", a.detalhe || ""]);
    }
    const csv = linhas.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `auditoria-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  async function recarregarGrupos() {
    const res = await fetch("/api/grupos");
    if (res.ok) setGruposList(await res.json());
  }
  async function recarregarMaquinas() {
    const res = await fetch("/api/maquinas");
    if (res.ok) setMaquinasList(await res.json());
  }

  async function atualizarAgente(maqId: string) {
    setAtualizandoMaquinaId(maqId);
    setUpdateMsg(null);
    try {
      const r = await fetch(`/api/maquinas/${maqId}/atualizar`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setUpdateMsg({ id: maqId, tipo: "ok", texto: `Sinal enviado — ${d.hostname ?? ""} atualizando para v${d.versaoAlvo}` });
        setTimeout(() => setUpdateMsg(null), 5000);
      } else {
        setUpdateMsg({ id: maqId, tipo: "erro", texto: d.erro || `Erro ${r.status}` });
        setTimeout(() => setUpdateMsg(null), 6000);
      }
    } catch {
      setUpdateMsg({ id: maqId, tipo: "erro", texto: "Falha de rede ao enviar sinal" });
      setTimeout(() => setUpdateMsg(null), 6000);
    } finally {
      setAtualizandoMaquinaId(null);
    }
  }

  async function atualizarLote(grupoId?: string) {
    const chave = grupoId ?? "all";
    setAtualizandoLoteGrupo(chave);
    setUpdateMsg(null);
    try {
      const body = grupoId ? { grupoId } : {};
      const r = await fetch("/api/maquinas/atualizar-lote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setUpdateMsg({ id: chave, tipo: "ok", texto: `${d.enviadas} máquina(s) receberam sinal de atualização para v${d.versaoAlvo}${d.ignoradas > 0 ? ` · ${d.ignoradas} já atualizadas/offline` : ""}` });
        setTimeout(() => setUpdateMsg(null), 6000);
      } else {
        setUpdateMsg({ id: chave, tipo: "erro", texto: d.erro || `Erro ${r.status}` });
        setTimeout(() => setUpdateMsg(null), 6000);
      }
    } catch {
      setUpdateMsg({ id: chave, tipo: "erro", texto: "Falha de rede" });
      setTimeout(() => setUpdateMsg(null), 6000);
    } finally {
      setAtualizandoLoteGrupo(null);
    }
  }

  function exportarRelatorioCsv() {
    const linhas = [["Empresa", "Maquinas", "Online", "Offline", "Departamentos"]];
    for (const emp of gruposList.filter((g) => g.tipo === "empresa")) {
      const ids = new Set<string>([emp.id, ...gruposList.filter((g) => g.tipo === "departamento" && g.parentId === emp.id).map((d) => d.id)]);
      const ms = maquinasList.filter((m) => m.grupoId && ids.has(m.grupoId));
      const on = ms.filter((m) => m.online).length;
      const deps = gruposList.filter((g) => g.tipo === "departamento" && g.parentId === emp.id).length;
      linhas.push([emp.nome, String(ms.length), String(on), String(ms.length - on), String(deps)]);
    }
    const csv = linhas.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `relatorio-empresas-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  // Permissão granular: owner tem tudo; senão checa a lista do usuário.
  const pode = (cap: string) => user?.papel === "owner" || (user?.permissoes || []).includes(cap);
  // Feature liberada pelo PLANO do tenant (não confundir com permissão do usuário).
  const temFeature = (f: string) => !user?.planoFeatures || user.planoFeatures.includes(f);

  async function abrirTenants() {
    setSecao("tenants"); setEmpresaFoco(null);
    try { const r = await fetch("/api/admin/tenants"); if (r.ok) { const d = await r.json(); setTenantsList(d.contas || []); setResumoPlataforma(d.resumo || null); } } catch {}
  }
  async function criarTenant() {
    if (!novoTenant.nome.trim() || !novoTenant.ownerEmail.trim() || novoTenant.ownerSenha.length < 8) { mostrarToast("Preencha nome, e-mail e senha (mín. 8).", "aviso"); return; }
    try {
      const r = await fetch("/api/admin/tenants", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(novoTenant) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { mostrarToast("Conta criada! O cliente já pode logar com o e-mail e senha informados.", "ok"); setNovoTenant({ nome: "", ownerEmail: "", ownerSenha: "", plano: "trial" }); abrirTenants(); }
      else mostrarToast("Erro: " + (j.erro || r.status), "erro");
    } catch { mostrarToast("Erro de rede.", "erro"); }
  }
  async function mudarPlanoTenant(id: string, plano: string) {
    try { const r = await fetch(`/api/admin/tenants/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plano }) }); if (r.ok) abrirTenants(); } catch {}
  }
  async function resetMfaTenant(id: string, owner: string) {
    if (!confirm(`Resetar o MFA do dono (${owner}) desta conta? Ele configura de novo no próximo login.`)) return;
    try { const r = await fetch(`/api/admin/tenants/${id}/reset-mfa`, { method: "POST" }); const j = await r.json().catch(() => ({})); if (r.ok) mostrarToast("MFA do dono resetado.", "ok"); else mostrarToast("Erro: " + (j.erro || r.status), "erro"); } catch { mostrarToast("Erro de rede.", "erro"); }
  }
  async function resetSenhaTenant(id: string, owner: string) {
    const s = prompt(`Nova senha para o dono (${owner}) — mín. 8 caracteres:`); if (!s) return;
    if (s.length < 8) { mostrarToast("Mínimo 8 caracteres.", "aviso"); return; }
    try { const r = await fetch(`/api/admin/tenants/${id}/reset-senha`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ senha: s }) }); const j = await r.json().catch(() => ({})); if (r.ok) mostrarToast("Senha do dono redefinida.", "ok"); else mostrarToast("Erro: " + (j.erro || r.status), "erro"); } catch { mostrarToast("Erro de rede.", "erro"); }
  }

  async function assinar(plano: string) {
    try {
      const r = await fetch("/api/assinar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plano }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.url) { window.location.href = j.url; }
      else mostrarToast("Não foi possível abrir o pagamento: " + (j.erro || r.status), "erro");
    } catch { mostrarToast("Erro de rede.", "erro"); }
  }

  async function abrirPlanos() {
    setSecao("planos"); setEmpresaFoco(null);
    try { const r = await fetch("/api/plano"); if (r.ok) setPlanoInfo(await r.json()); } catch {}
  }
  async function trocarPlano(plano: string) {
    if (!confirm(`Mudar para o plano ${plano}? (teste — depois isso vira pagamento)`)) return;
    try {
      const r = await fetch("/api/plano", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plano }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) abrirPlanos(); else mostrarToast("Erro: " + (j.erro || r.status), "erro");
    } catch { mostrarToast("Erro de rede.", "erro"); }
  }

  async function abrirSeguranca() {
    setSecao("seguranca");
    setEmpresaFoco(null);
    try { const r = await fetch("/api/seguranca"); if (r.ok) setSegConfig(await r.json()); } catch {}
    carregarRegrasAlerta();
    carregarRemediacoesLog();
    carregarAprovacoesPendentes();
  }
  async function salvarSeguranca(patch: { apenasBrasil?: boolean; forcar2fa?: boolean; nomeMarca?: string; logoUrl?: string }) {
    setSegConfig((p) => ({ ...p, ...patch }));
    try {
      const r = await fetch("/api/seguranca", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); mostrarToast("Erro: " + (j.erro || r.status), "erro"); abrirSeguranca(); }
    } catch { mostrarToast("Erro de rede.", "erro"); }
  }

  async function abrirUsuarios() {
    setVistaUsuarios(true);
    try {
      const res = await fetch("/api/usuarios");
      if (res.ok) setUsuariosList(await res.json());
      else if (res.status === 403) mostrarToast("Apenas owner/admin podem gerenciar usuários.", "aviso");
    } catch {}
    try {
      const r = await fetch("/api/notificacoes");
      if (r.ok) {
        const c = await r.json();
        setNotifCfg({
          webhookUrl: c.webhookUrl || "",
          formato: c.formato || "generico",
          telegramChatId: c.telegramChatId || "",
          minSeveridade: c.minSeveridade || "aviso",
          ativo: !!c.ativo,
          relatorioSemanal: !!c.relatorioSemanal,
          emailAtivo: !!c.emailAtivo,
          smtpHost: c.smtpHost || "",
          smtpPort: c.smtpPort || 587,
          smtpSeguro: c.smtpSeguro !== false,
          smtpUser: c.smtpUser || "",
          smtpPass: "",
          smtpFrom: c.smtpFrom || "",
          emailDestinatarios: c.emailDestinatarios || "",
          smtpDefinida: !!c.smtpDefinida,
        });
      }
    } catch {}
    // Telegram Bot API e toggles de alertas (nova config)
    if (!tgCarregado) {
      try {
        const r = await fetch("/api/config/notificacoes");
        if (r.ok) {
          const c = await r.json();
          setTgCfg({
            telegramAtivo: !!c.telegramAtivo,
            telegramBotToken: c.telegramBotToken || "",
            telegramChatIdBot: c.telegramChatIdBot || "",
            notifCritico: c.notifCritico !== false,
            notifAviso: !!c.notifAviso,
            notifOffline: c.notifOffline !== false,
          });
          setTgCarregado(true);
        }
      } catch {}
    }
  }

  async function salvarTgCfg() {
    setSalvandoTg(true);
    setTesteTgMsg(null);
    try {
      const body: any = { ...tgCfg };
      if (!body.telegramBotToken || body.telegramBotToken.includes("●")) delete body.telegramBotToken;
      const r = await fetch("/api/config/notificacoes", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r.ok) setTesteTgMsg({ tipo: "ok", texto: "Configuração Telegram salva!" });
      else { const j = await r.json().catch(() => ({})); setTesteTgMsg({ tipo: "erro", texto: j.erro || "Erro ao salvar" }); }
    } catch { setTesteTgMsg({ tipo: "erro", texto: "Erro de rede" }); }
    finally { setSalvandoTg(false); }
  }

  async function testarTelegram() {
    setSalvandoTg(true);
    setTesteTgMsg(null);
    try {
      const r = await fetch("/api/config/telegram/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ botToken: tgCfg.telegramBotToken?.includes("●") ? undefined : tgCfg.telegramBotToken, chatId: tgCfg.telegramChatIdBot }) });
      const j = await r.json().catch(() => ({}));
      setTesteTgMsg(r.ok ? { tipo: "ok", texto: "✅ Mensagem enviada! Confira o Telegram." } : { tipo: "erro", texto: "❌ " + (j.erro || "Falha") });
    } catch { setTesteTgMsg({ tipo: "erro", texto: "Erro de rede" }); }
    finally { setSalvandoTg(false); }
  }

  async function carregarRegrasAlerta() {
    if (regrasCarregadas) return;
    try {
      const r = await fetch("/api/config/regras-alerta");
      if (r.ok) { setRegrasAlerta(await r.json()); setRegrasCarregadas(true); }
    } catch {}
  }

  async function salvarRegrasAlerta() {
    setSalvandoRegras(true);
    try {
      const r = await fetch("/api/config/regras-alerta", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(regrasAlerta) });
      if (r.ok) mostrarToast("Regras de alerta salvas!", "ok");
      else { const j = await r.json().catch(() => ({})); mostrarToast("Erro: " + (j.erro || r.status), "erro"); }
    } catch { mostrarToast("Erro de rede.", "erro"); }
    finally { setSalvandoRegras(false); }
  }

  async function carregarRemediacoesLog() {
    if (remediacoesCarregadas) return;
    try {
      const r = await fetch("/api/remediacoes?limit=20");
      if (r.ok) { const j = await r.json(); setRemediacoesLog(j.remediacoes || []); setRemediacoesCarregadas(true); }
    } catch {}
  }

  async function carregarIaCatalogo() {
    if (iaCatalogo.length > 0) return;
    try {
      const r = await fetch("/api/config/ia/catalogo");
      if (r.ok) { const j = await r.json(); setIaCatalogo(j.acoes || []); }
    } catch {}
  }

  async function salvarIaMaquina(maquinaId: string, criticidade: string, iaRemediacao: boolean, iaAcoesPermitidas: string[]) {
    setSalvandoIaMaq(true);
    try {
      const r = await fetch(`/api/maquinas/${maquinaId}/ia`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ criticidade, iaRemediacao, iaAcoesPermitidas }) });
      if (r.ok) { mostrarToast("Configuração de IA salva!", "ok"); }
      else { const j = await r.json().catch(() => ({})); mostrarToast("Erro: " + (j.erro || r.status), "erro"); }
    } catch { mostrarToast("Erro de rede.", "erro"); }
    finally { setSalvandoIaMaq(false); }
  }

  async function registrarWebhookTelegram() {
    setRegTgMsg(null);
    try {
      const r = await fetch("/api/config/telegram/register-webhook", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      setRegTgMsg(r.ok ? { tipo: "ok", texto: `✅ Webhook registrado! URL: ${j.webhookUrl}` } : { tipo: "erro", texto: "❌ " + (j.erro || "Erro") });
    } catch { setRegTgMsg({ tipo: "erro", texto: "Erro de rede" }); }
  }

  async function registrarWebhookWhatsApp() {
    setRegWaMsg(null);
    try {
      const r = await fetch("/api/config/whatsapp/register-webhook", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      setRegWaMsg(r.ok ? { tipo: "ok", texto: `✅ Webhook WhatsApp registrado! URL: ${j.webhookUrl}` } : { tipo: "erro", texto: "❌ " + (j.erro || "Erro") });
    } catch { setRegWaMsg({ tipo: "erro", texto: "Erro de rede" }); }
  }

  async function carregarAprovacoesPendentes() {
    try {
      const r = await fetch("/api/remediacao-aprovacao");
      if (r.ok) { const j = await r.json(); setAprovacoesPendentes(j.aprovacoes || []); }
    } catch {}
  }

  async function aprovarRemediacao(id: string) {
    setAprovWh((p) => ({ ...p, [id]: true }));
    try {
      const r = await fetch(`/api/remediacao-aprovacao/${id}/aprovar`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      mostrarToast(j.mensagem || (r.ok ? "Aprovado!" : "Erro"), r.ok ? "ok" : "erro");
      carregarAprovacoesPendentes();
    } catch { mostrarToast("Erro de rede.", "erro"); }
    finally { setAprovWh((p) => ({ ...p, [id]: false })); }
  }

  async function recusarRemediacao(id: string) {
    setAprovWh((p) => ({ ...p, [id]: true }));
    try {
      const r = await fetch(`/api/remediacao-aprovacao/${id}/recusar`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      mostrarToast(j.mensagem || (r.ok ? "Cancelado." : "Erro"), r.ok ? "info" : "erro");
      carregarAprovacoesPendentes();
    } catch { mostrarToast("Erro de rede.", "erro"); }
    finally { setAprovWh((p) => ({ ...p, [id]: false })); }
  }

  async function testarEmail() {
    try {
      await salvarNotif();
      const res = await fetch("/api/notificacoes/testar-email", { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (j.ok) mostrarToast("E-mail de teste enviado! Confira a caixa de entrada (e o spam).", "ok");
      else mostrarToast("Falha: " + (j.erro || res.status), "erro");
    } catch { mostrarToast("Erro de rede.", "erro"); }
  }

  async function salvarNotif() {
    try {
      const res = await fetch("/api/notificacoes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(notifCfg),
      });
      if (res.ok) mostrarToast("Configuração de notificações salva!", "ok");
      else { const j = await res.json().catch(() => ({})); mostrarToast("Erro: " + (j.erro || res.status), "erro"); }
    } catch { mostrarToast("Erro de rede.", "erro"); }
  }

  async function testarNotif() {
    try {
      await fetch("/api/notificacoes", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(notifCfg) });
      const res = await fetch("/api/notificacoes/testar", { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (j.ok) mostrarToast("Notificação de teste enviada! Confira o seu canal.", "ok");
      else mostrarToast("Falha no teste: " + (j.erro || `status ${j.status || "?"}`), "erro");
    } catch { mostrarToast("Erro de rede.", "erro"); }
  }

  async function criarUsuario() {
    if (!novoUserEmail.trim() || novoUserSenha.length < 8) {
      mostrarToast("Informe um email válido e uma senha de pelo menos 8 caracteres.", "aviso");
      return;
    }
    try {
      const res = await fetch("/api/usuarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: novoUserEmail, senha: novoUserSenha, papel: novoUserPapel }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        setNovoUserEmail("");
        setNovoUserSenha("");
        setNovoUserPapel("operator");
        const r = await fetch("/api/usuarios");
        if (r.ok) setUsuariosList(await r.json());
      } else {
        mostrarToast("Erro: " + (j.erro || res.status), "erro");
      }
    } catch {
      mostrarToast("Erro de rede.", "erro");
    }
  }

  async function patchUsuario(id: string, body: any) {
    try {
      const res = await fetch(`/api/usuarios/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        const r = await fetch("/api/usuarios");
        if (r.ok) setUsuariosList(await r.json());
      } else {
        mostrarToast("Erro: " + (j.erro || res.status), "erro");
      }
    } catch {}
  }

  async function excluirUsuario(id: string, email: string) {
    if (!confirm(`Excluir o usuário ${email}? Esta ação não pode ser desfeita.`)) return;
    try {
      const res = await fetch(`/api/usuarios/${id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        const r = await fetch("/api/usuarios");
        if (r.ok) setUsuariosList(await r.json());
      } else mostrarToast("Erro: " + (j.erro || res.status), "erro");
    } catch { mostrarToast("Erro de rede.", "erro"); }
  }

  async function abrirTarefas() {
    setVistaTarefas(true);
    try {
      const res = await fetch("/api/tarefas");
      if (res.ok) setTarefasList(await res.json());
    } catch {}
  }

  async function criarTarefa() {
    if (!tarefaMaquina || !tarefaNome.trim() || !tarefaComando.trim()) {
      mostrarToast("Escolha a máquina e preencha nome e comando.", "aviso");
      return;
    }
    const body: any = { maquinaId: tarefaMaquina, nome: tarefaNome, comando: tarefaComando, shell: "powershell", frequencia: tarefaFreq };
    if (tarefaFreq === "diaria") body.horario = tarefaHorario;
    else body.dataUnica = tarefaDataUnica ? new Date(tarefaDataUnica).toISOString() : new Date(Date.now() + 60000).toISOString();
    try {
      const res = await fetch("/api/tarefas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) {
        setTarefaNome(""); setTarefaComando("");
        mostrarToast("Tarefa agendada com sucesso!", "ok");
        const r = await fetch("/api/tarefas"); if (r.ok) setTarefasList(await r.json());
      } else { const j = await res.json().catch(() => ({})); mostrarToast("Erro: " + (j.erro || res.status), "erro"); }
    } catch { mostrarToast("Erro de rede.", "erro"); }
  }

  async function toggleTarefa(id: string, ativo: boolean) {
    try {
      await fetch(`/api/tarefas/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ativo }) });
      const r = await fetch("/api/tarefas"); if (r.ok) setTarefasList(await r.json());
    } catch {}
  }

  async function excluirTarefa(id: string) {
    if (!confirm("Excluir esta tarefa agendada?")) return;
    try {
      const res = await fetch(`/api/tarefas/${id}`, { method: "DELETE" });
      if (res.ok) { const r = await fetch("/api/tarefas"); if (r.ok) setTarefasList(await r.json()); }
      else { const j = await res.json().catch(() => ({})); mostrarToast("Erro: " + (j.erro || res.status), "erro"); }
    } catch {}
  }

  async function carregarChamados() {
    try {
      const res = await fetch("/api/chamados");
      if (res.ok) setChamadosList(await res.json());
    } catch {}
  }

  async function abrirChamados() {
    setVistaChamados(true);
    setChamadoSel(null);
    setModoNovoChamado(false);
    await carregarChamados();
  }

  async function abrirDetalheChamado(id: string) {
    setModoNovoChamado(false);
    try {
      const res = await fetch(`/api/chamados/${id}`);
      if (res.ok) setChamadoSel(await res.json());
    } catch {}
  }

  async function criarChamado() {
    if (!novoTitulo.trim() || !novoDesc.trim()) {
      mostrarToast("Preencha título e descrição.", "aviso");
      return;
    }
    try {
      const res = await fetch("/api/chamados", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titulo: novoTitulo,
          descricao: novoDesc,
          prioridade: novoPrioridade,
          maquinaId: novoMaquinaId || null,
        }),
      });
      if (res.ok) {
        const novo = await res.json();
        setNovoTitulo("");
        setNovoDesc("");
        setNovoPrioridade("media");
        setNovoMaquinaId("");
        await carregarChamados();
        if (novo?.id) abrirDetalheChamado(novo.id);
      } else {
        mostrarToast("Erro ao criar chamado.", "erro");
      }
    } catch {
      mostrarToast("Erro de rede.", "erro");
    }
  }

  async function patchChamado(id: string, body: any) {
    try {
      const res = await fetch(`/api/chamados/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        await carregarChamados();
        await abrirDetalheChamado(id);
      }
    } catch {}
  }

  async function comentarChamado(id: string) {
    if (!comentarioTexto.trim()) return;
    try {
      const res = await fetch(`/api/chamados/${id}/comentarios`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texto: comentarioTexto }),
      });
      if (res.ok) {
        setComentarioTexto("");
        await abrirDetalheChamado(id);
      }
    } catch {}
  }

  // Helper: mostrar toast (substitui alert())
  function mostrarToast(msg: string, tipo: "ok" | "erro" | "info" | "aviso" = "info") {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev.slice(-3), { id, msg, tipo }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4500);
  }

  async function carregarAlertas() {
    try {
      const res = await fetch("/api/alertas");
      if (res.ok) {
        const j = await res.json();
        setAlertasList(j.alertas || []);
        setAlertasNaoLidas(j.naoLidas || 0);
      }
    } catch {}
  }

  async function marcarAlertasLidas() {
    try {
      await fetch("/api/alertas/marcar-lidas", { method: "POST" });
      setAlertasNaoLidas(0);
      setAlertasList((prev) => prev.map((a) => ({ ...a, lida: true })));
    } catch {}
  }

  async function marcarAlertaLido(a: any) {
    // Remove da lista e marca como lido
    setAlertasList((prev) => {
      const next = prev.filter((x) => x.id !== a.id);
      setAlertasNaoLidas(next.filter((x) => !x.lida).length);
      return next;
    });
    // Fecha o dropdown
    setMostrarAlertas(false);
    // Navega para a máquina, se o alerta tiver maquinaId
    if (a.maquinaId) {
      const maq = maquinasList.find((m) => m.id === a.maquinaId);
      if (maq) {
        setSecao("maquinas");
        gerenciarServicos(maq);
      }
    }
    try { await fetch(`/api/alertas/${a.id}/lida`, { method: "POST" }); } catch {}
  }

  function toggleSelecao(id: string) {
    setSelecionadas((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function executarAcaoMassa(action: "START" | "STOP" | "RESTART") {
    const ids = [...selecionadas];
    if (ids.length === 0) return;
    if (!servicoMassa.trim()) {
      mostrarToast("Digite o nome do serviço (ex.: Spooler).", "aviso");
      return;
    }
    const rotulo = { START: "Iniciar", STOP: "Parar", RESTART: "Reiniciar" }[action];
    if (!confirm(`${rotulo} o serviço "${servicoMassa.trim()}" em ${ids.length} máquina(s)?`)) return;
    setExecutandoMassa(true);
    try {
      const res = await fetch("/api/servicos/acao-em-massa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maquinaIds: ids, service: servicoMassa.trim(), action }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        mostrarToast(`Concluído: ${j.sucesso} ok, ${j.falha} falha(s) de ${j.total}.`, j.falha > 0 ? "aviso" : "ok");
        setSelecionadas(new Set());
      } else {
        mostrarToast("Falha: " + (j.erro || res.status), "erro");
      }
    } finally {
      setExecutandoMassa(false);
    }
  }

  async function removerMaquina(m: Maquina) {
    const nome = m.apelido || m.hostname;
    if (!confirm(`Remover a máquina "${nome}"?\n\nEla some das listagens. O histórico/auditoria é preservado, e reinstalar o agente nela reaproveita o registro.`)) return;
    const res = await fetch(`/api/maquinas/${m.id}`, { method: "DELETE" });
    if (res.ok) {
      setMaquinasList((prev) => prev.filter((x) => x.id !== m.id));
    } else {
      const j = await res.json().catch(() => ({}));
      mostrarToast("Não foi possível remover: " + (j.erro || res.status), "erro");
    }
  }

  async function executarComandoLote() {
    const ids = [...selecionadas];
    if (ids.length === 0 || !comandoLote.trim()) { mostrarToast("Selecione máquinas e insira um comando.", "aviso"); return; }
    if (!confirm(`Executar "${comandoLote.slice(0, 60)}${comandoLote.length > 60 ? "…" : ""}" em ${ids.length} máquina(s)?\n\nRequer MFA ativo.`)) return;
    setExecutandoLote(true);
    setResultadosLote(null);
    const resultados = await Promise.all(
      ids.map(async (id) => {
        const maq = maquinasList.find((m) => m.id === id);
        const hostname = maq?.apelido || maq?.hostname || id;
        try {
          const res = await fetch(`/api/maquinas/${id}/shell`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command: comandoLote, shell: "powershell" }),
          });
          const j = await res.json().catch(() => ({}));
          return { maquinaId: id, hostname, ok: res.ok && j.status !== "FALHA", saida: j.output || j.erro || (res.ok ? "Concluído" : `HTTP ${res.status}`) };
        } catch (e: any) {
          return { maquinaId: id, hostname, ok: false, saida: e.message || "Erro de rede" };
        }
      })
    );
    setResultadosLote(resultados);
    setExecutandoLote(false);
    const ok = resultados.filter((r) => r.ok).length;
    mostrarToast(`Lote concluído: ${ok} ok, ${resultados.length - ok} falha(s).`, ok === resultados.length ? "ok" : ok > 0 ? "aviso" : "erro");
  }

  async function carregarManutencoes(id: string) {
    setManutList(null);
    try { const r = await fetch(`/api/maquinas/${id}/manutencoes`); if (r.ok) setManutList(await r.json()); } catch {}
  }
  async function salvarManutencao() {
    if (!maquinaServicos || !novaManut.descricao.trim()) { mostrarToast("Descreva a manutenção.", "aviso"); return; }
    const body: any = { ...novaManut };
    if (body.proximaPreventiva) body.proximaPreventiva = new Date(body.proximaPreventiva + "T12:00:00").toISOString(); else delete body.proximaPreventiva;
    for (const k of ["pecasTrocadas", "tecnico", "custo"]) if (!body[k]) delete body[k];
    try {
      const r = await fetch(`/api/maquinas/${maquinaServicos.id}/manutencoes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { setNovaManut({ tipo: "corretiva", descricao: "", pecasTrocadas: "", tecnico: "", custo: "", proximaPreventiva: "" }); carregarManutencoes(maquinaServicos.id); mostrarToast("Manutenção registrada.", "ok"); }
      else mostrarToast("Erro: " + (j.erro || r.status), "erro");
    } catch { mostrarToast("Erro de rede.", "erro"); }
  }
  async function enviarAnexoManut(mid: string, file: File) {
    if (file.size > 6 * 1024 * 1024) { mostrarToast("Arquivo grande demais (máx 6MB).", "aviso"); return; }
    const dados: string = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(",")[1] || "");
      fr.onerror = rej; fr.readAsDataURL(file);
    });
    try {
      const r = await fetch(`/api/manutencoes/${mid}/anexos`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nome: file.name, tipo: file.type || "application/octet-stream", dados }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { if (maquinaServicos) carregarManutencoes(maquinaServicos.id); mostrarToast("Anexo enviado.", "ok"); }
      else mostrarToast("Erro: " + (j.erro || r.status), "erro");
    } catch { mostrarToast("Erro de rede.", "erro"); }
  }
  async function excluirAnexoManut(aid: string) {
    try { const r = await fetch(`/api/manutencoes/anexo/${aid}`, { method: "DELETE" }); if (r.ok && maquinaServicos) carregarManutencoes(maquinaServicos.id); } catch {}
  }

  async function excluirManutencao(mid: string) {
    if (!maquinaServicos) return;
    try { const r = await fetch(`/api/manutencoes/${mid}`, { method: "DELETE" }); if (r.ok) carregarManutencoes(maquinaServicos.id); } catch {}
  }
  async function salvarResponsavel() {
    if (!maquinaServicos) return;
    try {
      const r = await fetch(`/api/maquinas/${maquinaServicos.id}/responsavel`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ responsavel: respEdit || null }) });
      if (r.ok) { setMaquinaServicos({ ...maquinaServicos, responsavel: respEdit || null }); recarregarMaquinas(); }
    } catch {}
  }

  async function gerenciarServicos(m: Maquina) {
    setMaquinaServicos(m);
    setAbaAtiva("visao");
    carregarIaCatalogo();
    setCarregandoServicos(true);
    setFiltroServicos("");
    setServicos([]);
    setInventario(null);
    setLogs([]);
    setCveResultado(null); // limpar scan CVE ao trocar de máquina
    setProcessScan(null);  // limpar process scan ao trocar de máquina
    setRemediacaoResultado(null);
    setHealthHistory(null);
    setAuditTrail(null);
    carregarInventario(m.id);
    try {
      const res = await fetch(`/api/maquinas/${m.id}/servicos`);
      if (res.ok) {
        setServicos(await res.json());
      } else {
        mostrarToast("Erro ao buscar serviços da máquina.", "erro");
      }
    } catch {
      mostrarToast("Erro de rede ao buscar serviços.", "erro");
    } finally {
      setCarregandoServicos(false);
    }
  }

  async function carregarInventario(maquinaId: string) {
    setCarregandoInventario(true);
    setFiltroSoftware("");
    try {
      const res = await fetch(`/api/maquinas/${maquinaId}/inventario`);
      if (res.ok) {
        setInventario(await res.json());
      } else {
        setInventario(null);
      }
    } catch {
      mostrarToast("Erro de rede ao buscar inventário.", "erro");
    } finally {
      setCarregandoInventario(false);
    }
  }

  async function carregarLogs(maquinaId: string) {
    setCarregandoLogs(true);
    setLogs([]);
    setFiltroLogsStatus("");
    try {
      const res = await fetch(`/api/maquinas/${maquinaId}/logs`);
      if (res.ok) {
        setLogs(await res.json());
      }
    } catch {
      mostrarToast("Erro de rede ao buscar logs.", "erro");
    } finally {
      setCarregandoLogs(false);
    }
  }

  async function carregarResumoRelatorios() {
    try {
      const res = await fetch("/api/relatorios/resumo");
      if (res.ok) setResumoRelatorios(await res.json());
    } catch (err) {
      console.error("Erro ao carregar resumo de relatórios:", err);
    }
  }

  function exportarCsv() {
    if (!maquinaServicos || logs.length === 0) return;
    const cabecalhos = ["Data/Hora", "Usuario", "Servico", "Acao Executada", "Status", "Detalhes do Erro", "Hash Registro"];
    const linhas = logs.map(l => [
      new Date(l.executadoEm).toLocaleString(),
      l.usuarioEmail || "Sistema",
      l.servicoNome,
      l.acaoExecutada,
      l.statusResultado,
      l.detalhesErro || "",
      l.hashRegistro || ""
    ]);
    const conteudoCsv = [
      cabecalhos.join(","),
      ...linhas.map(row => row.map(val => `"${val.replace(/"/g, '""')}"`).join(","))
    ].join("\n");
    const blob = new Blob(["\uFEFF" + conteudoCsv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `historico-maquina-${maquinaServicos.apelido || maquinaServicos.hostname}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  async function desinstalarApp(nome: string) {
    if (!maquinaServicos) return;
    if (!confirm(`Desinstalar "${nome}"?\n\nIsso roda o desinstalador do programa na máquina (silencioso). Use se suspeitar de malware. A ação é auditada.`)) return;
    setDesinstalando(nome);
    try {
      const res = await fetch(`/api/maquinas/${maquinaServicos.id}/desinstalar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: nome }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        mostrarToast((j.output || "Desinstalação concluída.") + (j.status === "FALHA" ? ` ⚠️ ${j.erro || ""}` : ""), j.status === "FALHA" ? "aviso" : "ok");
        if (j.status !== "FALHA") carregarInventario(maquinaServicos.id);
      } else {
        mostrarToast("Não foi possível desinstalar: " + (j.erro || res.status) + " (máquina online? MFA?)", "erro");
      }
    } catch {
      mostrarToast("Erro de rede ao desinstalar.", "erro");
    } finally {
      setDesinstalando(null);
    }
  }

  async function listarArquivos(p: string) {
    if (!maquinaServicos) return;
    setCarregandoArq(true);
    try {
      const res = await fetch(`/api/maquinas/${maquinaServicos.id}/arquivos?path=${encodeURIComponent(p)}`);
      if (res.ok) {
        const j = await res.json();
        setCaminhoArq(j.caminho || "");
        setArquivosItens(j.itens || []);
      } else {
        const er = await res.json().catch(() => ({}));
        mostrarToast("Erro: " + (er.erro || res.status), "erro");
      }
    } catch { mostrarToast("Erro de rede (máquina online?).", "erro"); }
    finally { setCarregandoArq(false); }
  }

  function entrarPasta(nome: string) {
    const base = caminhoArq.replace(/[\\/]+$/, "");
    const novo = caminhoArq ? `${base}\\${nome}` : nome; // nas drives o nome já é "C:\"
    listarArquivos(caminhoArq ? novo : nome);
  }

  function voltarPasta() {
    if (!caminhoArq) return;
    const semBarra = caminhoArq.replace(/[\\/]+$/, "");
    const pai = semBarra.replace(/[\\/][^\\/]*$/, "");
    listarArquivos(/^[A-Za-z]:$/.test(pai) ? pai + "\\" : pai);
  }

  async function baixarArquivo(nome: string) {
    if (!maquinaServicos) return;
    const full = `${caminhoArq.replace(/[\\/]+$/, "")}\\${nome}`;
    try {
      const res = await fetch(`/api/maquinas/${maquinaServicos.id}/arquivo?path=${encodeURIComponent(full)}`);
      if (!res.ok) { const j = await res.json().catch(() => ({})); mostrarToast("Erro: " + (j.erro || res.status), "erro"); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = nome; a.click();
      URL.revokeObjectURL(url);
    } catch { mostrarToast("Erro ao baixar.", "erro"); }
  }

  async function enviarArquivo(file: File) {
    if (!maquinaServicos || !caminhoArq) { mostrarToast("Entre numa pasta primeiro.", "aviso"); return; }
    if (file.size > 10 * 1024 * 1024) { mostrarToast("Máximo 10MB.", "aviso"); return; }
    const b64: string = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.readAsDataURL(file); });
    const destino = `${caminhoArq.replace(/[\\/]+$/, "")}\\${file.name}`;
    try {
      const res = await fetch(`/api/maquinas/${maquinaServicos.id}/arquivo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: destino, conteudo: b64 }) });
      const j = await res.json().catch(() => ({}));
      if (res.ok) { mostrarToast(j.msg || "Arquivo enviado!", "ok"); listarArquivos(caminhoArq); }
      else mostrarToast("Erro: " + (j.erro || res.status), "erro");
    } catch { mostrarToast("Erro ao enviar.", "erro"); }
  }

  async function rodarComando() {
    if (!maquinaServicos || !comandoShell.trim()) return;
    setExecutandoShell(true);
    setSaidaShell("⏳ executando...");
    try {
      const res = await fetch(`/api/maquinas/${maquinaServicos.id}/shell`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: comandoShell, shell: "powershell" }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        setSaidaShell((j.output || "(sem saída)") + (j.status === "FALHA" ? `\n\n⚠️ ${j.erro || "falhou"}` : ""));
      } else {
        setSaidaShell(`❌ ${j.erro || res.status} (a máquina está online? MFA ok?)`);
      }
    } catch {
      setSaidaShell("❌ erro de rede");
    } finally {
      setExecutandoShell(false);
    }
  }

  function iniciarTerminal(shell: "powershell" | "cmd") {
    if (!maquinaServicos || !socketRef.current) return;
    setTerminalStatus("connecting");
    setActiveShellType(shell);
    // Registra início da sessão para rastrear duração e transcrição
    terminalStartedAtRef.current = Date.now();
    terminalMaquinaIdRef.current = maquinaServicos.id;
    terminalTranscriptRef.current = [];
    terminalLineBufferRef.current = "";
    socketRef.current.emit("admin:terminal-start", {
      machineId: maquinaServicos.id,
      shell,
    });
  }

  function pararTerminal() {
    const maqId = terminalMaquinaIdRef.current;
    const shell = activeShellType;
    if (socketRef.current && terminalSessionIdRef.current) {
      socketRef.current.emit("admin:terminal-stop", {
        sessionId: terminalSessionIdRef.current,
      });
    }
    setTerminalStatus("disconnected");
    setTerminalSessionId("");
    terminalSessionIdRef.current = "";
    if (xtermInstanceRef.current) {
      try { xtermInstanceRef.current.dispose(); } catch {}
      xtermInstanceRef.current = null;
    }
    setCopilotAtivo(false);
    setCopilotInput("");
    setCopilotPreview(null);
    copilotEncodingInitializedRef.current = false;
    // Gerar resumo da sessão em background
    if (maqId) {
      gerarResumoTerminal(maqId, shell);
    }
  }

  async function traduzirCopilot() {
    if (!copilotInput.trim() || copilotCarregando) return;
    setCopilotCarregando(true);
    setCopilotPreview(null);
    try {
      const resp = await fetch("/api/copilot/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          descricao: copilotInput,
          shell: activeShellType,
          soVersao: maquinaServicos?.soVersao ?? "Windows",
        }),
      });
      const data = await resp.json();
      if (data.comando) {
        setCopilotPreview({ comando: data.comando, explicacao: data.explicacao || "" });
      } else {
        setCopilotPreview({ comando: "", explicacao: data.explicacao || "Erro ao traduzir. Verifique a conexão." });
      }
    } catch {
      setCopilotPreview({ comando: "", explicacao: "Erro ao traduzir. Verifique a conexão." });
    } finally {
      setCopilotCarregando(false);
    }
  }

  function executarCopilot() {
    if (!copilotPreview?.comando || !socketRef.current || !terminalSessionIdRef.current) return;
    const sock = socketRef.current;
    const sid = terminalSessionIdRef.current;
    // Na primeira execução, configurar UTF-8 no PowerShell para evitar caracteres '?'
    if (!copilotEncodingInitializedRef.current) {
      copilotEncodingInitializedRef.current = true;
      sock.emit("admin:terminal-input", {
        sessionId: sid,
        data: "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null\r",
      });
    }
    sock.emit("admin:terminal-input", {
      sessionId: sid,
      data: copilotPreview.comando + "\r",
    });
    setCopilotInput("");
    setCopilotPreview(null);
  }

  async function toggleWatchdog(nomeServico: string, enabled: boolean) {
    if (!maquinaServicos) return;
    setExecutandoAcao(nomeServico);
    try {
      const res = await fetch(`/api/maquinas/${maquinaServicos.id}/servicos/${nomeServico}/watchdog`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) {
        const reloadRes = await fetch(`/api/maquinas/${maquinaServicos.id}/servicos`);
        if (reloadRes.ok) setServicos(await reloadRes.json());
      } else {
        const j = await res.json().catch(() => ({}));
        mostrarToast(`Erro no watchdog: ${j.erro || "Verifique o MFA / se o agente está online."}`, "erro");
      }
    } catch {
      mostrarToast("Erro de rede ao alterar o watchdog.", "erro");
    } finally {
      setExecutandoAcao(null);
    }
  }

  async function executarAcaoServico(nomeServico: string, action: string, startupType?: string) {
    if (!maquinaServicos) return;
    setExecutandoAcao(nomeServico);
    try {
      const res = await fetch(`/api/maquinas/${maquinaServicos.id}/servicos/${nomeServico}/acao`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, startupType }),
      });
      if (res.ok) {
        const reloadRes = await fetch(`/api/maquinas/${maquinaServicos.id}/servicos`);
        if (reloadRes.ok) {
          setServicos(await reloadRes.json());
        }
      } else {
        const errorData = await res.json();
        mostrarToast(`Erro ao executar ação: ${errorData.erro || "Verifique se concluiu o MFA."}`, "erro");
      }
    } catch {
      mostrarToast("Erro de rede ao executar ação.", "erro");
    } finally {
      setExecutandoAcao(null);
    }
  }

  // 1. Validar autenticação e buscar máquinas
  useEffect(() => {
    async function inicializarDashboard() {
      try {
        const meRes = await fetch("/api/auth/me");
        if (!meRes.ok) {
          router.push("/login");
          return;
        }

        const meData = await meRes.json();
        // Cliente (portal) não é forçado a MFA.
        if (!meData.mfaSatisfeito && meData.papel !== "cliente") {
          router.push(meData.mfaAtivo ? "/login" : "/mfa/setup");
          return;
        }
        setUser(meData);

        const [maqRes, grpRes, versaoRes] = await Promise.all([fetch("/api/maquinas"), fetch("/api/grupos"), fetch("/api/config/versao-agente")]);
        if (maqRes.ok) setMaquinasList(await maqRes.json());
        if (grpRes.ok) setGruposList(await grpRes.json());
        if (versaoRes.ok) { const vd = await versaoRes.json(); setVersaoProd(vd.versaoProd ?? null); }
        await carregarResumoRelatorios();
      } catch (err) {
        console.error("Erro ao carregar dados iniciais:", err);
      } finally {
        setCarregando(false);
      }
    }

    inicializarDashboard();
  }, [router]);

  // Polling de alertas (sininho) a cada 30s
  useEffect(() => {
    if (!user) return;
    carregarAlertas();
    const t = setInterval(carregarAlertas, 30000);
    return () => clearInterval(t);
  }, [user]);

  // Command palette — Ctrl+K abre, Escape fecha, / foca busca na aba máquinas
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      // Ctrl+K / Cmd+K → abre palette
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setPaletteAberta((prev) => {
          if (!prev) {
            setTimeout(() => paletteInputRef.current?.focus(), 30);
          }
          return !prev;
        });
        setPaletteQuery("");
        setPaletteIdx(0);
        return;
      }
      // Escape → fecha palette ou drawer
      if (e.key === "Escape") {
        setPaletteAberta(false);
        if (maquinaServicos) setMaquinaServicos(null);
        return;
      }
      // "/" → foca o campo de busca de máquinas (só quando não está em input/textarea)
      if (e.key === "/" && !paletteAberta) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA") {
          e.preventDefault();
          const el = document.getElementById("busca-maquinas");
          if (el) (el as HTMLInputElement).focus();
        }
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [maquinaServicos, paletteAberta]);

  // Briefing IA — carrega ao entrar no dashboard (ou ao recarregar manualmente)
  useEffect(() => {
    if (!user || secao !== "dashboard" || briefing !== null) return;
    setBriefingCarregando(true);
    fetch("/api/dashboard/briefing")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.briefing) setBriefing(d.briefing); })
      .catch(() => {})
      .finally(() => setBriefingCarregando(false));
  }, [user, secao, briefing]);

  // Saúde do servidor — carrega quando entra no dashboard (owner/superAdmin) e auto-refresh 30s
  useEffect(() => {
    const isOwner = user?.papel === "owner" || user?.superAdmin;
    if (!user || !isOwner) return;
    if (secao === "dashboard") {
      carregarServerHealth();
      serverHealthTimerRef.current = setInterval(carregarServerHealth, 30_000);
    } else {
      if (serverHealthTimerRef.current) {
        clearInterval(serverHealthTimerRef.current);
        serverHealthTimerRef.current = null;
      }
    }
    return () => {
      if (serverHealthTimerRef.current) {
        clearInterval(serverHealthTimerRef.current);
        serverHealthTimerRef.current = null;
      }
    };
  }, [user, secao]);

  // Contagem de chamados abertos (KPI do dashboard)
  useEffect(() => {
    if (!user) return;
    fetch("/api/chamados")
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => setChamadosAbertos((list || []).filter((c: any) => c.status === "aberto" || c.status === "em_andamento").length))
      .catch(() => {});
  }, [user, secao]);

  // Métricas ao vivo (CPU/RAM) enquanto o drawer de uma máquina está aberto
  useEffect(() => {
    const id = maquinaServicos?.id;
    if (!id) { setMetricas(null); return; }
    let alive = true;
    async function poll() {
      try {
        const r = await fetch(`/api/maquinas/${id}/metricas`);
        if (r.ok && alive) setMetricas(await r.json());
      } catch {}
    }
    poll();
    const t = setInterval(poll, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [maquinaServicos?.id]);

  // Histórico de métricas (24h) — atualiza a cada 60s
  useEffect(() => {
    const id = maquinaServicos?.id;
    if (!id) { setHistMetricas([]); return; }
    let alive = true;
    async function poll() {
      try {
        const r = await fetch(`/api/maquinas/${id}/metricas/historico?horas=24`);
        if (r.ok && alive) { const j = await r.json(); setHistMetricas(j.amostras || []); }
      } catch {}
    }
    poll();
    const t = setInterval(poll, 60000);
    return () => { alive = false; clearInterval(t); };
  }, [maquinaServicos?.id]);

  // Previsão de esgotamento de disco — carrega ao selecionar máquina
  useEffect(() => {
    const id = maquinaServicos?.id;
    if (!id) { setDiscosPrevisao([]); return; }
    fetch(`/api/maquinas/${id}/disco/previsao`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setDiscosPrevisao(d.discos ?? []); })
      .catch(() => {});
  }, [maquinaServicos?.id]);

  // A) Health History sparkline — carrega ao selecionar máquina e aba visao
  useEffect(() => {
    const id = maquinaServicos?.id;
    if (!id || abaAtiva !== "visao") { setHealthHistory(null); return; }
    carregarHealthHistory(id);
  }, [maquinaServicos?.id, abaAtiva]);

  // I) Audit Trail — carrega ao abrir aba manutencao
  useEffect(() => {
    const id = maquinaServicos?.id;
    if (!id || abaAtiva !== "manutencao") { setAuditTrail(null); return; }
    carregarAuditTrail(id);
  }, [maquinaServicos?.id, abaAtiva]);

  // B) Heatmap — carrega ao abrir dashboard
  useEffect(() => {
    if (secao !== "dashboard") return;
    if (!alertHeatmap) carregarHeatmap();
  }, [secao]);

  // E) WhatsApp config — carrega ao abrir notificações (dentro de segurança)
  useEffect(() => {
    if (secao === "seguranca" && !waCfg) carregarWaCfg();
  }, [secao]);

  // 2. Conectar WebSocket administrativo (/admin)
  useEffect(() => {
    if (!user) return;

    let socket: Socket;
    try {
      socket = io("/admin", {
        transports: ["websocket"],
        timeout: 5000,
      });
      socketRef.current = socket;

      socket.on("connect", () => {
        setSocketConectado(true);
      });

      socket.on("disconnect", () => {
        setSocketConectado(false);
      });

      // Ouvinte de eventos de presença
      socket.on("admin:machine-presence", (data: { machineId: string; online: boolean; vistoEm: number; versaoAgente?: string }) => {
        setMaquinasList((prev) =>
          prev.map((m) =>
            m.id === data.machineId
              ? {
                  ...m,
                  online: data.online,
                  vistoEm: new Date(data.vistoEm).toISOString(),
                  ...(data.versaoAgente !== undefined ? { versaoAgente: data.versaoAgente } : {}),
                }
              : m
          )
        );
      });

      // Notificações em tempo real (novo alerta criado pelo gateway)
      socket.on("admin:nova-notificacao", (data: { id: string; maquinaId?: string | null; tipo: string; severidade: string; mensagem: string; lida: boolean; criadoEm: string }) => {
        setAlertasList((prev) => [data, ...prev].slice(0, 50));
        setAlertasNaoLidas((prev) => prev + 1);
      });

      // Atualização de localização em tempo real (dispositivos móveis)
      socket.on("admin:location-update", (data: { machineId: string; latitude: number; longitude: number; precisaoMetros: number | null; localizacaoEm: string }) => {
        setMaquinasList((prev) => prev.map((m) =>
          m.id === data.machineId
            ? { ...m, latitude: data.latitude, longitude: data.longitude, precisaoMetros: data.precisaoMetros, localizacaoEm: data.localizacaoEm }
            : m,
        ));
        // Atualiza também o painel de detalhe se estiver aberto
        setMaquinaServicos((prev) => prev?.id === data.machineId
          ? { ...prev, latitude: data.latitude, longitude: data.longitude, precisaoMetros: data.precisaoMetros, localizacaoEm: data.localizacaoEm }
          : prev,
        );
      });

      // Ouvintes do Terminal SSH Interativo
      socket.on("admin:terminal-started", (data: { sessionId: string }) => {
        setTerminalSessionId(data.sessionId);
        terminalSessionIdRef.current = data.sessionId;
        setTerminalStatus("connected");
      });

      socket.on("admin:terminal-error", (data: { error: string }) => {
        mostrarToast("Erro no terminal: " + data.error, "erro");
        setTerminalStatus("disconnected");
        setTerminalSessionId("");
        terminalSessionIdRef.current = "";
      });

      socket.on("admin:terminal-stdout", (data: { sessionId: string; data: string }) => {
        if (data.sessionId === terminalSessionIdRef.current && xtermInstanceRef.current) {
          xtermInstanceRef.current.write(data.data);
        }
      });

      socket.on("admin:terminal-exit", (data: { sessionId: string; code?: number }) => {
        if (data.sessionId === terminalSessionIdRef.current) {
          if (xtermInstanceRef.current) {
            xtermInstanceRef.current.write("\r\n\x1b[31m[NEXUS RMM] Fechando túnel e encerrando processos...\x1b[0m\r\n");
            xtermInstanceRef.current.write("\x1b[31m[NEXUS RMM] Sessão finalizada.\x1b[0m\r\n");
          }
          // Gerar resumo em background antes de limpar estado
          const maqId = terminalMaquinaIdRef.current;
          const shell = activeShellType;
          if (maqId) gerarResumoTerminal(maqId, shell);
          setTimeout(() => {
            setTerminalStatus("disconnected");
            setTerminalSessionId("");
            terminalSessionIdRef.current = "";
          }, 1500);
        }
      });

      socket.on("admin:monitors-list", (data: { machineId: string; monitores: MonitorInfo[] }) => {
        setMonitoresMaquina(data.monitores ?? []);
      });

    } catch (err) {
      console.error("Erro ao inicializar WebSocket admin:", err);
    }

    return () => {
      if (socket) {
        socket.disconnect();
        socketRef.current = null;
      }
    };
  }, [user]);

  // Efeito para desconectar o terminal se trocar de máquina ou aba
  useEffect(() => {
    if (abaAtiva !== "terminal" && terminalStatus !== "disconnected") {
      pararTerminal();
    }
  }, [abaAtiva, maquinaServicos?.id]);

  // Instanciar Xterm.js no cliente quando conectado
  useEffect(() => {
    if (terminalStatus !== "connected" || !terminalContainerRef.current) {
      if (xtermInstanceRef.current) {
        try { xtermInstanceRef.current.dispose(); } catch {}
        xtermInstanceRef.current = null;
      }
      return;
    }

    let isMounted = true;
    let term: any;
    let fitAddon: any;

    async function initXterm() {
      try {
        const { Terminal } = await import("xterm");
        const { FitAddon } = await import("xterm-addon-fit");

        if (!isMounted || !terminalContainerRef.current) return;

        term = new Terminal({
          cursorBlink: true,
          windowsMode: true,       // reflow correto p/ shell do Windows sem PTY (corrige quebra de linha)
          convertEol: true,        // trata \n como nova linha
          scrollback: 5000,        // histórico de rolagem
          theme: {
            background: "#09090b", // zinc-950
            foreground: "#10b981", // emerald-500
            cursor: "#10b981",
            cursorAccent: "#09090b",
            selectionBackground: "rgba(16, 185, 129, 0.25)",
          },
          fontSize: 13,
          fontFamily: "var(--font-mono), ui-monospace, Courier New, monospace",
        });

        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(terminalContainerRef.current);
        term.focus();
        
        term.write("\x1b[32m[NEXUS RMM] Estabelecendo túnel de terminal seguro com o agente...\x1b[0m\r\n");
        term.write("\x1b[32m[NEXUS RMM] Conexão mTLS estabelecida. Sessão autorizada.\x1b[0m\r\n");
        term.write("\x1b[32m[NEXUS RMM] Conectado e pronto para uso.\x1b[0m\r\n\r\n");
        
        setTimeout(() => {
          if (isMounted) {
            try { fitAddon.fit(); } catch {}
          }
        }, 150);

        xtermInstanceRef.current = term;
        fitAddonRef.current = fitAddon;

        term.onData((data: string) => {
          if (socketRef.current && terminalSessionIdRef.current) {
            socketRef.current.emit("admin:terminal-input", {
              sessionId: terminalSessionIdRef.current,
              data,
            });
          }
          // Captura de transcrição: acumula chars e submete ao pressionar Enter
          if (data === "\r" || data === "\n") {
            const linha = terminalLineBufferRef.current.trim().toLowerCase();
            // cls / clear: limpa o xterm client-side (pipe mode não retorna ANSI clear)
            // \x1b[2J = apaga tela; \x1b[H = cursor no topo; \x1b[3J = apaga scrollback
            if (linha === "cls" || linha === "clear") {
              try { xtermInstanceRef.current?.write('\x1b[2J\x1b[H\x1b[3J'); } catch {}
            }
            if (terminalLineBufferRef.current.trim().length > 0) {
              terminalTranscriptRef.current.push(terminalLineBufferRef.current.trim());
            }
            terminalLineBufferRef.current = "";
          } else if (data === "\x7f" || data === "\b") {
            // Backspace — remove último char
            terminalLineBufferRef.current = terminalLineBufferRef.current.slice(0, -1);
          } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
            // Char imprimível
            terminalLineBufferRef.current += data;
          }
        });

        const handleResize = () => {
          if (fitAddon) {
            try { fitAddon.fit(); } catch {}
          }
        };
        window.addEventListener("resize", handleResize);
        term._resizeListener = handleResize;

        // Refaz o ajuste sempre que o container mudar de tamanho + avisa o PTY do agente (cols/rows).
        const emitirResize = () => {
          try { fitAddon.fit(); } catch {}
          if (socketRef.current && terminalSessionIdRef.current && term) {
            try { socketRef.current.emit("admin:terminal-resize", { sessionId: terminalSessionIdRef.current, cols: term.cols, rows: term.rows }); } catch {}
          }
        };
        try {
          const ro = new ResizeObserver(() => emitirResize());
          if (terminalContainerRef.current) ro.observe(terminalContainerRef.current);
          term._resizeObserver = ro;
        } catch {}
        setTimeout(emitirResize, 250);

      } catch (err: any) {
        console.error("Erro ao iniciar Xterm.js:", err);
        mostrarToast("Erro ao carregar emulador de terminal: " + err.message, "erro");
      }
    }

    initXterm();

    return () => {
      isMounted = false;
      if (term) {
        if (term._resizeListener) {
          window.removeEventListener("resize", term._resizeListener);
        }
        if (term._resizeObserver) {
          try { term._resizeObserver.disconnect(); } catch {}
        }
        try { term.dispose(); } catch {}
      }
      xtermInstanceRef.current = null;
      fitAddonRef.current = null;
    };
  }, [terminalStatus]);

  // Realizar logout
  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  // Gerar token de enrollment
  async function abrirModalCadastro() {
    setModalAberto(true);
    setGerandoToken(true);
    setTokenGerado("");
    setCopiouToken(false);
    setCopiouComando(false);

    try {
      const res = await fetch("/api/enroll-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          descricao: `Token gerado via painel em ${new Date().toLocaleDateString()}`,
          maxUsos: 1,
          expiraEmHoras: 24,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setTokenGerado(data.token);
      } else {
        setTokenGerado("Erro ao gerar token.");
      }
    } catch (err) {
      setTokenGerado("Erro de rede ao gerar token.");
    } finally {
      setGerandoToken(false);
    }
  }

  // Wake-on-LAN: envia magic packet para ligar a máquina remotamente
  async function enviarWol(m: Maquina) {
    if (enviandoWol) return;
    setEnviandoWol(m.id);
    try {
      const res = await fetch(`/api/maquinas/${m.id}/wol`, { method: "POST" });
      const j = await res.json();
      if (res.ok) {
        mostrarToast(`Magic packet enviado${j.via === "peer" ? " via agente peer" : " direto do servidor"}. A máquina deve ligar em alguns segundos.`, "ok");
      } else {
        mostrarToast(`Erro ao enviar WoL: ${j.erro || j.detalhe || "desconhecido"}`, "erro");
      }
    } catch {
      mostrarToast("Erro de rede ao enviar WoL.", "erro");
    } finally {
      setEnviandoWol(null);
    }
  }

  // Acesso não supervisionado à tela: pede um grant efêmero e abre o viewer.
  // O admin NÃO digita senha de tela — a credencial é injetada pelo servidor.
  async function abrirTela(m: Maquina) {
    setAbrindoTela(m.id);
    setMonitoresMaquina([]);
    setMonitorIdx(0);
    setMaquinaTelaId(m.id);
    try {
      const res = await fetch(`/api/maquinas/${m.id}/tela`, { method: "POST" });
      if (!res.ok) {
        mostrarToast(
          res.status === 404
            ? "Máquina não encontrada."
            : "Não foi possível abrir a tela (verifique se você concluiu o MFA).",
          "erro",
        );
        return;
      }
      const data = await res.json();
      setTelaUrl(data.viewerUrl);
      setTelaNome(m.apelido || m.hostname);
      // Solicitar lista de monitores via Socket.io (resposta chega em admin:monitors-list)
      if (socketRef.current?.connected) {
        socketRef.current.emit("admin:list-monitors", { machineId: m.id });
      }
    } catch {
      mostrarToast("Erro de rede ao abrir a tela.", "erro");
    } finally {
      setAbrindoTela(null);
    }
  }

  function selecionarMonitor(idx: number) {
    setMonitorIdx(idx);
    if (socketRef.current?.connected && maquinaTelaId) {
      socketRef.current.emit("admin:screen-select-monitor", { machineId: maquinaTelaId, monitorIdx: idx });
    }
  }

  // --- Grupos: criar/atribuir ---
  function pedirTexto(titulo: string, valorInicial = ""): Promise<string | null> {
    return new Promise((resolve) => setPromptCfg({ titulo, valor: valorInicial, resolve }));
  }

  async function criarEmpresa() {
    const nome = await pedirTexto("Nome da nova empresa (cliente):");
    if (!nome?.trim()) return;
    const res = await fetch("/api/grupos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: nome.trim(), tipo: "empresa" }),
    });
    if (res.ok) recarregarGrupos();
    else mostrarToast("Não foi possível criar a empresa (verifique se concluiu o MFA).", "erro");
  }
  async function criarDepartamento(empresaId: string) {
    const nome = await pedirTexto("Nome do novo departamento:");
    if (!nome?.trim()) return;
    const res = await fetch("/api/grupos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: nome.trim(), tipo: "departamento", parentId: empresaId }),
    });
    if (res.ok) recarregarGrupos();
    else mostrarToast("Não foi possível criar o departamento (verifique se concluiu o MFA).", "erro");
  }
  async function atribuirMaquina(
    maquinaId: string,
    patch: { grupoId?: string | null; tipoMaquina?: "pc" | "notebook" | "servidor" | "mobile" | "tablet"; apelido?: string | null; tags?: string[] },
  ) {
    const res = await fetch(`/api/maquinas/${maquinaId}/grupo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) recarregarMaquinas();
    else mostrarToast("Não foi possível atualizar (verifique se concluiu o MFA).", "erro");
  }

  async function salvarTags(m: Maquina, tags: string[]) {
    await atribuirMaquina(m.id, { tags });
    if (maquinaServicos && maquinaServicos.id === m.id) setMaquinaServicos({ ...maquinaServicos, tags });
  }
  function adicionarTag(m: Maquina, t: string) {
    const tag = t.trim().toLowerCase();
    if (!tag || (m.tags || []).includes(tag)) return;
    salvarTags(m, [...(m.tags || []), tag]);
  }
  function removerTag(m: Maquina, t: string) {
    salvarTags(m, (m.tags || []).filter((x) => x !== t));
  }

  // Redimensionar colunas (arrastar a borda do cabeçalho)
  function iniciarResize(e: React.MouseEvent, chave: string) {
    e.preventDefault();
    const x0 = e.clientX;
    const th = (e.currentTarget as HTMLElement).closest("th");
    const w0 = th ? th.offsetWidth : 120;
    const onMove = (ev: MouseEvent) => setColW((p) => ({ ...p, [chave]: Math.max(60, w0 + (ev.clientX - x0)) }));
    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  async function renomearMaquina(m: Maquina) {
    const novo = await pedirTexto("Nome amigável da máquina:", m.apelido ?? m.hostname);
    if (novo === null) return;
    await atribuirMaquina(m.id, { apelido: novo.trim() });
  }

  // --- Grupos: hierarquia + filtro ---
  const empresas = gruposList.filter((g) => g.tipo === "empresa");
  const departamentosDe = (empId: string) =>
    gruposList.filter((g) => g.tipo === "departamento" && g.parentId === empId);
  const maquinasDaEmpresa = (empId: string) => {
    const ids = new Set<string>([empId, ...departamentosDe(empId).map((d) => d.id)]);
    return maquinasList.filter((m) => m.grupoId && ids.has(m.grupoId));
  };
  const tituloSecao: Record<string, string> = {
    dashboard: "Dashboard",
    maquinas: "Máquinas",
    empresas: "Empresas (clientes)",
    relatorios: "Relatórios",
    seguranca: "Segurança",
    planos: "Planos & Cobrança",
    tenants: "Contas de Clientes",
    docs: "Documentação",
  };
  const nomeGrupo = (id: string | null) =>
    id ? gruposList.find((g) => g.id === id)?.nome ?? "—" : "Sem grupo";

  const idsDoFiltro: Set<string> | null = (() => {
    if (!grupoSelecionado) return null;
    const sel = gruposList.find((g) => g.id === grupoSelecionado);
    if (!sel) return new Set<string>();
    if (sel.tipo === "empresa")
      return new Set<string>([sel.id, ...departamentosDe(sel.id).map((d) => d.id)]);
    return new Set<string>([sel.id]);
  })();
  const maquinasFiltradas = (idsDoFiltro
    ? maquinasList.filter((m) => m.grupoId && idsDoFiltro.has(m.grupoId))
    : maquinasList
  )
    .filter((m) => !filtroTag || (m.tags || []).includes(filtroTag))
    .filter((m) => {
      if (!filtroSO) return true;
      const so = (m.soVersao || "").toLowerCase();
      if (filtroSO === "windows") return so.includes("windows");
      if (filtroSO === "linux") return so.includes("linux");
      if (filtroSO === "macos") return so.includes("mac") || so.includes("darwin");
      return true;
    })
    .filter((m) => {
      const q = busca.trim().toLowerCase();
      if (!q) return true;
      return (
        (m.apelido || "").toLowerCase().includes(q) ||
        m.hostname.toLowerCase().includes(q) ||
        (m.tags || []).some((t: string) => t.toLowerCase().includes(q))
      );
    });

  // Linhas agrupadas por Empresa -> Departamento (com seção "Sem empresa").
  const linhasAgrupadas: Array<{ tipo: "empresa" | "dept" | "maquina"; nome?: string; id?: string; m?: any }> = (() => {
    const linhas: Array<{ tipo: "empresa" | "dept" | "maquina"; nome?: string; id?: string; m?: any }> = [];
    const colocadas = new Set<string>();
    for (const emp of empresas) {
      const deps = departamentosDe(emp.id);
      const maqDireta = maquinasFiltradas.filter((m) => m.grupoId === emp.id);
      const temNosDeps = deps.some((d) => maquinasFiltradas.some((m) => m.grupoId === d.id));
      if (maqDireta.length === 0 && !temNosDeps) continue;
      linhas.push({ tipo: "empresa", nome: emp.nome, id: emp.id });
      for (const m of maqDireta) { linhas.push({ tipo: "maquina", m }); colocadas.add(m.id); }
      for (const d of deps) {
        const maqD = maquinasFiltradas.filter((m) => m.grupoId === d.id);
        if (maqD.length === 0) continue;
        linhas.push({ tipo: "dept", nome: d.nome });
        for (const m of maqD) { linhas.push({ tipo: "maquina", m }); colocadas.add(m.id); }
      }
    }
    const semGrupo = maquinasFiltradas.filter((m) => !colocadas.has(m.id));
    if (semGrupo.length > 0) {
      linhas.push({ tipo: "empresa", nome: "Sem empresa / departamento" });
      for (const m of semGrupo) linhas.push({ tipo: "maquina", m });
    }
    return linhas;
  })();

  const servicosFiltrados = servicos.filter(
    (s: any) =>
      s.nome.toLowerCase().includes(filtroServicos.toLowerCase()) ||
      (s.displayName && s.displayName.toLowerCase().includes(filtroServicos.toLowerCase()))
  );

  // Estatísticas
  const totalDispositivos = maquinasList.length;
  const onlineDispositivos = maquinasList.filter((m) => m.online).length;
  const offlineDispositivos = totalDispositivos - onlineDispositivos;

  // Formata o comando PowerShell dinâmico
  const host = typeof window !== "undefined" ? window.location.host : "rmm.gmtec.tec.br";
  const protocol = typeof window !== "undefined" ? window.location.protocol : "https:";
  const comandoPowerShell = `Set-ExecutionPolicy Bypass -Scope Process -Force; [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12; iex ((New-Object System.Net.WebClient).DownloadString('${protocol}//${host}/instalar.ps1')); Instalar-Nexus -Token "${tokenGerado}"`;
  const comandoLinux    = `curl -sSL ${protocol}//${host}/instalar-linux.sh | sudo bash -s -- --token=${tokenGerado}`;
  const comandoMac      = `curl -sSL ${protocol}//${host}/instalar-macos.sh | sudo bash -s -- --token=${tokenGerado}`;
  const urlApkAndroid   = `${protocol}//${host}/nexus-rmm-agent.apk`;

  function copiarParaTransferência(texto: string, setCopiou: React.Dispatch<React.SetStateAction<boolean>>) {
    navigator.clipboard.writeText(texto);
    setCopiou(true);
    setTimeout(() => setCopiou(false), 2000);
  }

  if (carregando) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-24">
        <span className="w-10 h-10 border-4 border-zinc-800 border-t-emerald-500 rounded-full animate-spin"></span>
        <p className="text-zinc-500 text-sm mt-4">Carregando painel de controle...</p>
      </div>
    );
  }

  // ===== ACESSO SUSPENSO (trial ou assinatura vencida) — muro de assinatura =====
  if (user?.acesso?.bloqueado) {
    const venceu = user.acesso.motivo === "vencido";
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6" style={{ background: "#06060a" }}>
        <div className="max-w-md w-full text-center glass-panel rounded-2xl p-8 border border-amber-500/30">
          <div className="text-5xl mb-3">⏳</div>
          <h1 className="text-2xl font-bold text-white">{venceu ? "Sua assinatura venceu" : "Seu teste de 7 dias acabou"}</h1>
          <p className="text-zinc-400 text-sm mt-2">Seus dados estão <b>salvos</b>. {venceu ? "Renove" : "Assine um plano"} para voltar a usar o Nexus RMM.</p>
          <div className="grid grid-cols-2 gap-3 mt-6">
            <button onClick={() => assinar("essencial")} className="px-4 py-3 rounded-xl border border-zinc-700 font-bold text-sm text-white hover:border-cyan-500/50 cursor-pointer">Essencial<br /><span className="text-xs text-zinc-500">R$149/mês · 25 máq.</span></button>
            <button onClick={() => assinar("pro")} className="px-4 py-3 rounded-xl font-bold text-sm cursor-pointer" style={{ background: "linear-gradient(90deg,#10b981,#22d3ee)", color: "#04121a" }}>Pro<br /><span className="text-xs">R$399/mês · 150 máq.</span></button>
          </div>
          <a href="https://wa.me/5565984174850" target="_blank" rel="noreferrer" className="block mt-4 text-xs text-emerald-400 hover:underline">💬 Falar no WhatsApp</a>
          <button onClick={handleLogout} className="mt-3 text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer">Sair</button>
        </div>
      </div>
    );
  }

  // ===== PORTAL DO CLIENTE (papel "cliente") — experiência simplificada =====
  if (user?.papel === "cliente") {
    const minhas = maquinasList;
    const on = minhas.filter((m) => m.online).length;
    const nomeEmp = empresas.map((e) => e.nome).join(", ") || "Sua empresa";
    return (
      <div className="flex-1 overflow-y-auto bg-zinc-950">
        <header className="sticky top-0 z-10 bg-zinc-950/90 backdrop-blur border-b border-zinc-800 px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {user.marca?.logoUrl ? <img src={user.marca.logoUrl} alt="" className="h-8 rounded" /> : <span className="text-emerald-400 text-xl">●</span>}
            <div>
              <div className="text-white font-bold text-sm">{user.marca?.nome || "Portal do Cliente"}</div>
              <div className="text-[11px] text-zinc-500">{nomeEmp}</div>
            </div>
          </div>
          <button onClick={handleLogout} className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-400 hover:text-white cursor-pointer">Sair</button>
        </header>

        <main className="max-w-5xl mx-auto p-5 space-y-5">
          <div>
            <h1 className="text-xl font-bold text-white">Olá! 👋</h1>
            <p className="text-xs text-zinc-500">Acompanhe seus equipamentos e abra chamados de suporte.</p>
          </div>

          <div className="grid grid-cols-3 gap-3">
            {[{ l: "Equipamentos", v: minhas.length, c: "text-white" }, { l: "Online", v: on, c: "text-emerald-400" }, { l: "Offline", v: minhas.length - on, c: "text-zinc-400" }].map((k) => (
              <div key={k.l} className="glass-panel rounded-xl p-4 border border-zinc-800"><div className="text-[10px] text-zinc-500 uppercase tracking-wider">{k.l}</div><div className={`text-2xl font-bold font-mono ${k.c}`}>{k.v}</div></div>
            ))}
          </div>

          <div className="glass-panel rounded-2xl border border-zinc-800 overflow-hidden">
            <div className="px-4 py-3 text-sm font-bold text-white border-b border-zinc-800">Seus equipamentos</div>
            <div className="divide-y divide-zinc-900/60">
              {minhas.length === 0 ? <p className="p-6 text-xs text-zinc-500 text-center">Nenhum equipamento cadastrado.</p> :
              minhas.map((m) => {
                const sd = m.saude || (m.online ? "ok" : "offline");
                const cor = sd === "critico" ? "bg-red-500" : sd === "alerta" ? "bg-amber-500" : sd === "ok" ? "bg-emerald-500" : "bg-zinc-600";
                return (
                  <div key={m.id} className="flex items-center gap-3 px-4 py-3">
                    <span className={`w-2.5 h-2.5 rounded-full ${cor}`}></span>
                    <div className="flex-1 min-w-0"><div className="text-sm text-white truncate">{m.apelido || m.hostname}</div><div className="text-[11px] text-zinc-500">{m.online ? `Online${m.cpu != null ? ` · CPU ${m.cpu}% · RAM ${m.ram}%` : ""}` : `Offline · visto ${m.vistoEm ? new Date(m.vistoEm).toLocaleString() : "—"}`}</div></div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="glass-panel rounded-2xl border border-zinc-800 p-4 space-y-2">
            <h3 className="text-sm font-bold text-white">🎫 Abrir chamado de suporte</h3>
            <input value={novoTitulo} onChange={(e) => setNovoTitulo(e.target.value)} placeholder="Assunto (ex.: Computador lento)" className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/40" />
            <textarea value={novoDesc} onChange={(e) => setNovoDesc(e.target.value)} placeholder="Descreva o problema…" rows={3} className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-200 resize-none focus:outline-none focus:border-emerald-500/40" />
            <div className="flex gap-2 items-center">
              <select value={novoPrioridade} onChange={(e) => setNovoPrioridade(e.target.value)} className="px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-300 cursor-pointer">
                <option value="baixa">Baixa</option><option value="media">Média</option><option value="alta">Alta</option><option value="critica">Crítica</option>
              </select>
              <button onClick={criarChamado} className="px-4 py-2 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-sm font-bold text-emerald-300 cursor-pointer">Enviar chamado</button>
            </div>
          </div>

          <div className="glass-panel rounded-2xl border border-zinc-800 overflow-hidden">
            <div className="px-4 py-3 text-sm font-bold text-white border-b border-zinc-800">Meus chamados</div>
            <div className="divide-y divide-zinc-900/60">
              {(chamadosList || []).length === 0 ? <p className="p-6 text-xs text-zinc-500 text-center">Nenhum chamado ainda.</p> :
              chamadosList.map((c) => (
                <div key={c.id} className="px-4 py-3"><div className="flex justify-between gap-2"><span className="text-sm text-white truncate">{c.titulo}</span><span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400 shrink-0">{c.status}</span></div><div className="text-[11px] text-zinc-500 mt-0.5">prioridade: {c.prioridade}</div></div>
              ))}
            </div>
          </div>

          <p className="text-center text-[10px] text-zinc-600 py-4">Suporte por {user.marca?.nome || "Nexus RMM"}</p>
        </main>
      </div>
    );
  }

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Sidebar */}
      <Sidebar
        secao={secao}
        socketConectado={socketConectado}
        user={user}
        alertasNaoLidas={alertasNaoLidas}
        pode={pode}
        onNavegar={(s) => { setSecao(s as any); setEmpresaFoco(null); }}
        onAbrirChamados={abrirChamados}
        onAbrirTarefas={abrirTarefas}
        onAbrirUsuarios={abrirUsuarios}
        onAbrirSeguranca={abrirSeguranca}
        onAbrirPlanos={abrirPlanos}
        onAbrirTenants={abrirTenants}
        onLogout={handleLogout}
      />

      {/* Coluna de conteúdo */}
      <div className="flex-1 flex flex-col min-w-0 overflow-y-auto pb-16 lg:pb-0">
        <Header
          titulo={empresaFoco ? (empresas.find((e) => e.id === empresaFoco)?.nome || "Empresa") : tituloSecao[secao]}
          alertasList={alertasList}
          alertasNaoLidas={alertasNaoLidas}
          mostrarAlertas={mostrarAlertas}
          onToggleAlertas={() => setMostrarAlertas((v) => !v)}
          onMarcarTodasLidas={marcarAlertasLidas}
          onMarcarAlertaLido={marcarAlertaLido}
        />

      {/* DASHBOARD */}
      {secao === "dashboard" && (() => {
        const totalMaq = maquinasList.length;
        const onlineMaq = maquinasList.filter((m) => m.online).length;
        const offlineMaq = totalMaq - onlineMaq;
        const saudePct = totalMaq ? Math.round((onlineMaq / totalMaq) * 100) : 0;
        const saudeCor = saudePct >= 80 ? "emerald" : saudePct >= 50 ? "amber" : "red";
        const maqComScore = maquinasList.filter((m) => m.online && m.healthScore != null);
        const avgHealthScore = maqComScore.length > 0
          ? Math.round(maqComScore.reduce((s, m) => s + (m.healthScore ?? 0), 0) / maqComScore.length)
          : null;
        const avgHealthCor = avgHealthScore == null ? saudeCor : avgHealthScore >= 80 ? "emerald" : avgHealthScore >= 60 ? "amber" : "red";

        // SVG icons inline para os KPI cards
        const IconBuilding = () => (
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 21h18M6 21V7l6-4 6 4v14"/><path d="M9 21v-4h6v4"/><rect x="9" y="9" width="2" height="2"/><rect x="13" y="9" width="2" height="2"/>
          </svg>
        );
        const IconMonitor = () => (
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
          </svg>
        );
        const IconCircleCheck = () => (
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9"/><polyline points="9 12 11 14 15 10"/>
          </svg>
        );
        const IconCircleX = () => (
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>
          </svg>
        );
        const IconTicket = () => (
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 5H5a2 2 0 0 0-2 2v2a2 2 0 0 1 0 4v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2a2 2 0 0 1 0-4V7a2 2 0 0 0-2-2h-4"/>
            <path d="M10 9h4M10 12h4M10 15h4"/>
          </svg>
        );
        const IconActivity = () => (
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
        );
        const IconAlertTriangle = () => (
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        );

        return (
        <main className="max-w-[1600px] w-full mx-auto p-4 md:p-6 space-y-5">
          {/* Briefing IA */}
          {(briefingCarregando || briefing) && (
            <div className="glass-panel-neon rounded-2xl px-5 py-4 border border-zinc-800 flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0 mt-0.5">
                <svg className="w-4 h-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a10 10 0 1 0 10 10H12V2z"/><path d="M12 2a10 10 0 0 1 10 10"/><path d="M12 12l4-4"/>
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                {briefingCarregando ? (
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-xs text-zinc-500">Analisando infraestrutura...</span>
                  </div>
                ) : (
                  <p className="text-sm text-zinc-200 leading-relaxed">{briefing}</p>
                )}
              </div>
              {briefing && (
                <button
                  onClick={() => setBriefing(null)}
                  title="Atualizar"
                  className="text-zinc-600 hover:text-zinc-400 shrink-0 cursor-pointer mt-0.5"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                </button>
              )}
            </div>
          )}

          {/* Row 1 — KPI Cards */}
          <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiCard
              titulo="Empresas"
              valor={empresas.length}
              icon={<IconBuilding />}
              cor="white"
              onClick={() => { setSecao("empresas"); setEmpresaFoco(null); }}
            />
            <KpiCard
              titulo="Máquinas"
              valor={totalMaq}
              icon={<IconMonitor />}
              cor="white"
              onClick={() => { setSecao("maquinas"); setEmpresaFoco(null); }}
            />
            <KpiCard
              titulo="Online"
              valor={onlineMaq}
              icon={<IconCircleCheck />}
              cor="emerald"
              onClick={() => { setSecao("maquinas"); setEmpresaFoco(null); }}
            />
            <KpiCard
              titulo="Offline"
              valor={offlineMaq}
              icon={<IconCircleX />}
              cor={offlineMaq > 0 ? "red" : "zinc"}
              onClick={() => { setSecao("maquinas"); setEmpresaFoco(null); }}
            />
            <KpiCard
              titulo="Chamados abertos"
              valor={chamadosAbertos}
              icon={<IconTicket />}
              cor="amber"
              onClick={abrirChamados}
            />
            <KpiCard
              titulo="Saude geral"
              valor={avgHealthScore != null ? `${avgHealthScore}` : `${saudePct}%`}
              icon={<IconActivity />}
              cor={avgHealthCor}
              subtitulo={avgHealthScore != null ? `score médio · ${onlineMaq} online` : `${onlineMaq} de ${totalMaq} online`}
            />
          </section>

          {/* Row 2 — Attention panel + Company health */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Precisa de atenção */}
            <div className="glass-panel rounded-2xl p-4 border border-zinc-800/80">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-amber-400"><IconAlertTriangle /></span>
                <h3 className="text-sm font-bold text-white">Precisa de atenção</h3>
              </div>
              {(() => {
                const offline = maquinasList.filter((m) => !m.online);
                const criticos = alertasList.filter((a: any) => a.severidade === "critico" && !a.lida);
                if (offline.length === 0 && criticos.length === 0) {
                  return (
                    <div className="py-8 flex flex-col items-center gap-2">
                      <div className="w-10 h-10 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                        <svg className="w-5 h-5 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      </div>
                      <p className="text-xs text-zinc-500">Tudo certo por aqui</p>
                    </div>
                  );
                }
                return (
                  <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                    {criticos.slice(0, 8).map((a: any) => (
                      <div key={a.id} className="flex items-start gap-2.5 p-2 rounded-lg bg-red-500/5 border border-red-500/10">
                        <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0 mt-1.5" />
                        <span className="text-xs text-red-300 leading-snug truncate">{a.mensagem}</span>
                      </div>
                    ))}
                    {offline.slice(0, 15).map((m: any) => (
                      <div key={m.id} className="flex items-start gap-2.5 p-2 rounded-lg bg-zinc-900/40 border border-zinc-800/60">
                        <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 shrink-0 mt-1.5" />
                        <span className="text-xs text-zinc-400 leading-snug truncate">{m.apelido || m.hostname} — offline</span>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>

            {/* Saúde por empresa */}
            <div className="glass-panel rounded-2xl p-4 border border-zinc-800/80">
              <div className="flex items-center gap-2 mb-3">
                <svg className="w-3.5 h-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 21h18M6 21V7l6-4 6 4v14"/><path d="M9 21v-4h6v4"/>
                </svg>
                <h3 className="text-sm font-bold text-white">Saude por empresa</h3>
              </div>
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {empresas.length === 0 ? (
                  <div className="text-xs text-zinc-500 py-6 text-center">Nenhuma empresa cadastrada.</div>
                ) : empresas.map((emp) => {
                  const ms = maquinasDaEmpresa(emp.id);
                  const on = ms.filter((m) => m.online).length;
                  const pct = ms.length ? Math.round((on / ms.length) * 100) : 0;
                  return (
                    <button
                      key={emp.id}
                      onClick={() => { setGrupoSelecionado(emp.id); setSecao("maquinas"); }}
                      className="w-full text-left p-2.5 rounded-xl bg-zinc-900/40 border border-zinc-800/60 hover:border-emerald-500/30 hover:bg-zinc-900/70 cursor-pointer transition-all duration-150 group"
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-semibold text-white truncate group-hover:text-emerald-300 transition-colors">{emp.nome}</span>
                        <span className="text-[10px] text-zinc-500 shrink-0 ml-2 font-mono">
                          <span style={{ color: pct >= 80 ? "#10b981" : pct >= 50 ? "#f59e0b" : "#ef4444" }} className="font-bold">{on}</span>
                          <span className="text-zinc-600">/{ms.length}</span>
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{ width: `${pct}%`, background: pct >= 80 ? "#10b981" : pct >= 50 ? "#f59e0b" : "#ef4444" }}
                        />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Widget Saúde do Servidor — só para owner/superAdmin */}
          {(user?.papel === "owner" || user?.superAdmin) && (
            <div className="glass-panel rounded-2xl border border-zinc-800/80 overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800/50">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
                    <svg className="w-3.5 h-3.5 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/>
                      <line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-bold text-white">Servidor RMM</p>
                    <p className="text-[10px] text-zinc-500 font-mono">
                      {serverHealth ? `atualizado ${new Date(serverHealth.timestamp).toLocaleTimeString("pt-BR")} · uptime ${serverHealth.uptime.texto}` : "carregando…"}
                    </p>
                  </div>
                </div>
                <button
                  onClick={carregarServerHealth}
                  disabled={serverHealthCarregando}
                  title="Atualizar agora"
                  className="w-7 h-7 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-500 hover:text-zinc-300 cursor-pointer disabled:opacity-40 transition-colors"
                >
                  <svg className={`w-3.5 h-3.5 ${serverHealthCarregando ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                    <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                  </svg>
                </button>
              </div>

              {serverHealth ? (
                <div className="p-5">
                  {/* Grid de métricas principais */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                    {/* CPU */}
                    {(() => {
                      const v = serverHealth.cpu.usoPct;
                      const cor = v >= 85 ? "#ef4444" : v >= 60 ? "#f59e0b" : "#06b6d4";
                      return (
                        <div className="rounded-xl bg-zinc-900/50 border border-zinc-800/60 p-3">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">CPU</span>
                            <span className="text-xl font-extrabold font-mono" style={{ color: cor }}>{v}%</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden mb-2">
                            <div className="h-full rounded-full transition-all duration-700" style={{ width: `${v}%`, background: cor }} />
                          </div>
                          <p className="text-[9px] text-zinc-600 font-mono truncate">{serverHealth.cpu.nucleos} núcleos · load {serverHealth.cpu.loadAvg.m1}/{serverHealth.cpu.loadAvg.m5}/{serverHealth.cpu.loadAvg.m15}</p>
                        </div>
                      );
                    })()}

                    {/* RAM */}
                    {(() => {
                      const v = serverHealth.ram.usoPct;
                      const cor = v >= 85 ? "#ef4444" : v >= 65 ? "#f59e0b" : "#06b6d4";
                      return (
                        <div className="rounded-xl bg-zinc-900/50 border border-zinc-800/60 p-3">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">RAM</span>
                            <span className="text-xl font-extrabold font-mono" style={{ color: cor }}>{v}%</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden mb-2">
                            <div className="h-full rounded-full transition-all duration-700" style={{ width: `${v}%`, background: cor }} />
                          </div>
                          <p className="text-[9px] text-zinc-600 font-mono">{serverHealth.ram.usadoGB} GB / {serverHealth.ram.totalGB} GB</p>
                        </div>
                      );
                    })()}

                    {/* Disco */}
                    {(() => {
                      const v = serverHealth.disco.usoPct;
                      const cor = v >= 85 ? "#ef4444" : v >= 70 ? "#f59e0b" : "#06b6d4";
                      return (
                        <div className="rounded-xl bg-zinc-900/50 border border-zinc-800/60 p-3">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Disco</span>
                            <span className="text-xl font-extrabold font-mono" style={{ color: cor }}>{v}%</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden mb-2">
                            <div className="h-full rounded-full transition-all duration-700" style={{ width: `${v}%`, background: cor }} />
                          </div>
                          <p className="text-[9px] text-zinc-600 font-mono">{serverHealth.disco.usadoGB} GB / {serverHealth.disco.totalGB} GB</p>
                        </div>
                      );
                    })()}

                    {/* Uptime + processo */}
                    <div className="rounded-xl bg-zinc-900/50 border border-zinc-800/60 p-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Uptime</span>
                        <span className="text-sm font-extrabold font-mono text-cyan-400">{serverHealth.uptime.texto}</span>
                      </div>
                      <div className="space-y-1 mt-1">
                        <p className="text-[9px] text-zinc-600 font-mono">Processo: {serverHealth.processo.heapUsadoMB} MB heap</p>
                        <p className="text-[9px] text-zinc-600 font-mono">RSS total: {serverHealth.processo.rssMB} MB</p>
                        {serverHealth.redis.memHuman && (
                          <p className="text-[9px] text-zinc-600 font-mono">Redis: {serverHealth.redis.memHuman} · {serverHealth.redis.conexoes} conn</p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Info do CPU */}
                  <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-zinc-950/40 border border-zinc-800/40">
                    <svg className="w-3 h-3 text-zinc-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/>
                      <line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/>
                      <line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/>
                      <line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="15" x2="23" y2="15"/>
                      <line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="15" x2="4" y2="15"/>
                    </svg>
                    <p className="text-[10px] text-zinc-500 font-mono truncate">{serverHealth.cpu.modelo}</p>
                    <span className="ml-auto text-[9px] text-zinc-700 font-mono shrink-0">auto-refresh 30s</span>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center py-10 gap-2">
                  <div className="w-4 h-4 border border-cyan-500/30 border-t-cyan-400 rounded-full animate-spin" />
                  <span className="text-xs text-zinc-500">Lendo métricas do servidor…</span>
                </div>
              )}
            </div>
          )}

          {/* B) Heatmap de alertas por hora */}
          <div className="glass-panel rounded-2xl p-5 border border-zinc-800">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <svg className="w-3.5 h-3.5 text-orange-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="4" height="4" rx="0.5"/><rect x="10" y="3" width="4" height="4" rx="0.5"/><rect x="17" y="3" width="4" height="4" rx="0.5"/>
                    <rect x="3" y="10" width="4" height="4" rx="0.5"/><rect x="10" y="10" width="4" height="4" rx="0.5"/><rect x="17" y="10" width="4" height="4" rx="0.5"/>
                    <rect x="3" y="17" width="4" height="4" rx="0.5"/><rect x="10" y="17" width="4" height="4" rx="0.5"/><rect x="17" y="17" width="4" height="4" rx="0.5"/>
                  </svg>
                  Heatmap de Alertas por Hora do Dia
                </h3>
                <p className="text-[10px] text-zinc-500 mt-0.5">Últimos 30 dias — horário de Cuiabá</p>
              </div>
              <button onClick={carregarHeatmap} disabled={carregandoHeatmap} className="inline-flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 cursor-pointer disabled:opacity-40 transition-colors duration-150">
                <svg className={`w-3 h-3 ${carregandoHeatmap ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                  <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                </svg>
                atualizar
              </button>
            </div>
            {!alertHeatmap ? (
              <div className="flex items-center gap-2 py-6 justify-center">
                <div className="w-4 h-4 border-2 border-zinc-800 border-t-amber-500 rounded-full animate-spin" />
                <span className="text-xs text-zinc-500">Calculando heatmap…</span>
              </div>
            ) : (
              <div>
                <div className="grid grid-cols-12 gap-1 mb-1">
                  {[0,1,2,3,4,5,6,7,8,9,10,11].map(h => (
                    <div key={h} className="text-center text-[9px] text-zinc-600">{String(h).padStart(2,"0")}h</div>
                  ))}
                </div>
                <div className="grid grid-cols-12 gap-1 mb-1">
                  {Array.from({length: 12}, (_, h) => {
                    const d = alertHeatmap.horas[h] ?? { total: 0 };
                    const pct = alertHeatmap.maxTotal > 0 ? d.total / alertHeatmap.maxTotal : 0;
                    const bg = pct === 0 ? "bg-zinc-900" : pct < 0.3 ? "bg-amber-500/20" : pct < 0.6 ? "bg-amber-500/50" : pct < 0.85 ? "bg-orange-500/70" : "bg-red-500/80";
                    return (
                      <div key={h} title={`${String(h).padStart(2,"0")}:00 — ${d.total} alertas`}
                        className={`h-8 rounded ${bg} border border-zinc-800/50 cursor-default transition-colors`} />
                    );
                  })}
                </div>
                <div className="grid grid-cols-12 gap-1 mb-1">
                  {[12,13,14,15,16,17,18,19,20,21,22,23].map(h => (
                    <div key={h} className="text-center text-[9px] text-zinc-600">{String(h).padStart(2,"0")}h</div>
                  ))}
                </div>
                <div className="grid grid-cols-12 gap-1">
                  {Array.from({length: 12}, (_, i) => {
                    const h = i + 12;
                    const d = alertHeatmap.horas[h] ?? { total: 0 };
                    const pct = alertHeatmap.maxTotal > 0 ? d.total / alertHeatmap.maxTotal : 0;
                    const bg = pct === 0 ? "bg-zinc-900" : pct < 0.3 ? "bg-amber-500/20" : pct < 0.6 ? "bg-amber-500/50" : pct < 0.85 ? "bg-orange-500/70" : "bg-red-500/80";
                    return (
                      <div key={h} title={`${String(h).padStart(2,"0")}:00 — ${d.total} alertas`}
                        className={`h-8 rounded ${bg} border border-zinc-800/50 cursor-default transition-colors`} />
                    );
                  })}
                </div>
                <div className="flex items-center gap-3 mt-3 justify-end">
                  <span className="text-[9px] text-zinc-600">Menos ↔ Mais:</span>
                  {["bg-zinc-900","bg-amber-500/20","bg-amber-500/50","bg-orange-500/70","bg-red-500/80"].map((c,i) => (
                    <div key={i} className={`w-4 h-4 rounded ${c} border border-zinc-800/50`}></div>
                  ))}
                </div>
              </div>
            )}
          </div>

        </main>
        );
      })()}

      {/* EMPRESAS (clientes) */}
      {secao === "empresas" && (
        <main className="max-w-[1600px] w-full mx-auto p-4 md:p-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {empresas.length === 0 ? <div className="col-span-full text-center py-16 text-zinc-500 text-sm">Nenhuma empresa cadastrada. Crie empresas e departamentos na aba Máquinas.</div> :
            empresas.map((emp) => { const ms = maquinasDaEmpresa(emp.id); const on = ms.filter((m) => m.online).length; const deps = departamentosDe(emp.id); return (
              <button key={emp.id} onClick={() => { setGrupoSelecionado(emp.id); setSecao("maquinas"); }} className="glass-panel rounded-2xl p-5 border border-zinc-800 hover:border-emerald-500/30 text-left cursor-pointer transition-colors">
                <h3 className="text-base font-bold text-white truncate flex items-center gap-2">
                  <svg className="w-3.5 h-3.5 text-zinc-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 21h18M6 21V7l6-4 6 4v14"/><path d="M9 21v-4h6v4"/>
                  </svg>
                  {emp.nome}
                </h3>
                <div className="grid grid-cols-3 gap-2 mt-4 text-center">
                  <div><div className="text-2xl font-extrabold text-white font-mono">{ms.length}</div><div className="text-[10px] text-zinc-500 uppercase">Máquinas</div></div>
                  <div><div className="text-2xl font-extrabold text-emerald-400 font-mono">{on}</div><div className="text-[10px] text-zinc-500 uppercase">Online</div></div>
                  <div><div className="text-2xl font-extrabold text-zinc-400 font-mono">{deps.length}</div><div className="text-[10px] text-zinc-500 uppercase">Deptos</div></div>
                </div>
              </button>
            ); })}
          </div>
        </main>
      )}

      {/* RELATÓRIOS */}
      {secao === "relatorios" && (() => {
        const rr = resumoRelatorios;
        const idsEmpresa = relEmpresa ? new Set(maquinasDaEmpresa(relEmpresa).map((m: any) => m.id)) : null;
        const mqsFilt = idsEmpresa ? maquinasList.filter((m) => idsEmpresa.has(m.id)) : null;
        const mq = mqsFilt
          ? { total: mqsFilt.length, online: mqsFilt.filter((m) => m.online).length, offline: mqsFilt.filter((m) => !m.online).length, pcs: mqsFilt.filter((m) => m.tipoMaquina === "pc" || m.tipoMaquina === "notebook").length, servidores: mqsFilt.filter((m) => m.tipoMaquina === "servidor").length, mobiles: mqsFilt.filter((m) => m.tipoMaquina === "mobile" || m.tipoMaquina === "tablet").length }
          : (rr?.maquinas || { total: 0, online: 0, offline: 0, pcs: 0, servidores: 0 });
        const nomeEmpresaFiltro = relEmpresa ? (empresas.find((e) => e.id === relEmpresa)?.nome || "") : "";
        const saude = mq.total ? Math.round((mq.online / mq.total) * 100) : 0;
        const ativ: Array<{ data: string; quantidade: number }> = rr?.atividadeUltimos7Dias || [];
        const maxAtiv = Math.max(1, ...ativ.map((a) => a.quantidade));
        const acoes7 = ativ.reduce((s, a) => s + a.quantidade, 0);
        const acoes: any[] = rr?.ultimasAcoes || [];
        const kpis = [
          { l: "Máquinas", v: mq.total, c: "text-white" },
          { l: "Online", v: mq.online, c: "text-emerald-400" },
          { l: "Offline", v: mq.offline, c: "text-zinc-400" },
          { l: "Saúde", v: saude + "%", c: saude >= 80 ? "text-emerald-400" : saude >= 50 ? "text-amber-400" : "text-red-400" },
          { l: "PCs", v: mq.pcs, c: "text-cyan-400" },
          { l: "Servidores", v: mq.servidores, c: "text-violet-400" },
          ...(((mq as any).mobiles ?? 0) > 0 ? [{ l: "📱 Mobile", v: (mq as any).mobiles, c: "text-amber-400" }] : []),
        ];
        return (
        <main className="max-w-[1600px] w-full mx-auto p-4 md:p-6 space-y-5 nexus-report">
          <style>{`@media print { aside, .no-print { display:none !important; } .nexus-report { padding:0 !important; max-width:100% !important; } body, .nexus-report, .glass-panel { background:#fff !important; } .nexus-report, .nexus-report * { color:#111 !important; } .glass-panel { border:1px solid #ccc !important; box-shadow:none !important; } .barra-print { background:#10b981 !important; -webkit-print-color-adjust:exact; print-color-adjust:exact; } }`}</style>
          <div className="flex justify-between items-center flex-wrap gap-3 no-print">
            <div>
              <h3 className="text-base font-bold text-white">📈 Relatório operacional {nomeEmpresaFiltro ? <span className="text-emerald-400">· {nomeEmpresaFiltro}</span> : null}</h3>
              <p className="text-[11px] text-zinc-500">Gerado em {new Date().toLocaleString()}</p>
            </div>
            <div className="flex gap-2 items-center">
              <select value={relEmpresa} onChange={(e) => setRelEmpresa(e.target.value)} title="Filtrar por empresa (cliente)" className="px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 cursor-pointer max-w-[200px]">
                <option value="">Todas as empresas</option>
                {empresas.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
              </select>
              <button onClick={() => { carregarResumoRelatorios(); }} className="px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs font-semibold text-zinc-300 hover:text-white cursor-pointer">↻ Atualizar</button>
              <button onClick={() => window.open(`/api/relatorios/executivo${relEmpresa ? `?empresaId=${relEmpresa}` : ""}`, "_blank")} className="px-4 py-2 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 text-xs font-semibold text-blue-300 cursor-pointer">📄 Relatório PDF</button>
              <button onClick={() => window.print()} className="px-4 py-2 rounded-lg bg-violet-500/10 hover:bg-violet-500/20 border border-violet-500/30 text-xs font-semibold text-violet-300 cursor-pointer">🖨️ Imprimir / PDF</button>
              <button onClick={exportarRelatorioCsv} className="px-4 py-2 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-xs font-semibold text-emerald-300 cursor-pointer">📥 CSV</button>
            </div>
          </div>

          <div className="hidden print:block mb-2">
            {user?.marca?.logoUrl ? <img src={user.marca.logoUrl} alt="" style={{ maxHeight: 50, marginBottom: 6 }} /> : null}
            <h1 className="text-xl font-bold">{user?.marca?.nome || "Nexus RMM"} — Relatório Operacional{nomeEmpresaFiltro ? ` · ${nomeEmpresaFiltro}` : ""}</h1>
            <p className="text-xs">Gerado em {new Date().toLocaleString()}</p>
          </div>

          <div className="flex gap-2 no-print border-b border-zinc-800/60 pb-3">
            <button onClick={() => setRelAba("operacional")} className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer ${relAba === "operacional" ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30" : "text-zinc-500 hover:text-zinc-300"}`}>📊 Operacional</button>
            <button onClick={() => { setRelAba("auditoria"); if (!auditoria) carregarAuditoria(0); }} className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer ${relAba === "auditoria" ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30" : "text-zinc-500 hover:text-zinc-300"}`}>🔎 Rastreabilidade</button>
            <button onClick={() => { setRelAba("inventario"); if (!invConsolidado) carregarInvConsolidado(); }} className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer ${relAba === "inventario" ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30" : "text-zinc-500 hover:text-zinc-300"}`}>📦 Inventário</button>
            <button onClick={() => { setRelAba("manutencoes"); if (!manutReport) carregarManutReport(); }} className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer ${relAba === "manutencoes" ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30" : "text-zinc-500 hover:text-zinc-300"}`}>🔧 Manutenções</button>
            <button onClick={() => { setRelAba("sla"); if (!slaDados) carregarSla(); }} className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer ${relAba === "sla" ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30" : "text-zinc-500 hover:text-zinc-300"}`}>📶 SLA</button>
          </div>

          {relAba === "operacional" && (<>
          {/* KPIs */}
          <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
            {kpis.map((k) => (
              <div key={k.l} className="glass-panel rounded-xl p-3 border border-zinc-800">
                <div className="text-[10px] text-zinc-500 uppercase tracking-wider">{k.l}</div>
                <div className={`text-2xl font-bold font-mono ${k.c}`}>{k.v}</div>
              </div>
            ))}
          </div>

          {/* Atividade 7 dias */}
          <div className="glass-panel rounded-2xl p-5 border border-zinc-800">
            <h4 className="text-sm font-bold text-white mb-4">Atividade — últimos 7 dias <span className="text-zinc-500 font-normal">· {acoes7} ações</span></h4>
            <div className="flex items-end gap-2 h-36">
              {ativ.map((a, idx) => {
                const isLast = idx === ativ.length - 1;
                const pct = (a.quantidade / maxAtiv) * 100;
                const isEmpty = a.quantidade === 0;
                const barBg = isLast
                  ? "#10b981"
                  : isEmpty
                  ? "rgba(16,185,129,0.15)"
                  : "rgba(16,185,129,0.55)";
                const date = new Date(a.data + "T00:00");
                const diaSemana = date.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "").replace(/^\w/, (c) => c.toUpperCase());
                const diaMes = date.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" });
                return (
                  <div key={a.data} className="flex-1 flex flex-col items-center gap-1 justify-end">
                    {!isEmpty && (
                      <div className={`text-[9px] font-mono ${isLast ? "text-emerald-400 font-bold" : "text-zinc-500"}`}>{a.quantidade}</div>
                    )}
                    <div
                      className="w-full rounded-t barra-print transition-all duration-300"
                      style={{
                        height: `${isEmpty ? 2 : Math.max(pct, 4)}%`,
                        background: barBg,
                        boxShadow: isLast ? "0 0 8px rgba(16,185,129,0.4)" : "none",
                      }}
                      title={`${diaSemana} ${diaMes}: ${a.quantidade} ações`}
                    />
                    <div className={`text-[9px] text-center leading-tight ${isLast ? "text-emerald-400/80" : "text-zinc-600"}`}>
                      <div className="font-semibold">{diaSemana}</div>
                      <div>{diaMes}</div>
                    </div>
                  </div>
                );
              })}
              {ativ.length === 0 && <div className="text-xs text-zinc-500">Sem dados.</div>}
            </div>
          </div>

          {/* Resumo por empresa */}
          <div className="glass-panel rounded-2xl border border-zinc-800 overflow-hidden">
            <div className="px-4 py-3 text-sm font-bold text-white border-b border-zinc-800">Saúde por empresa</div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] text-zinc-500 uppercase tracking-wider border-b border-zinc-800">
                  <th className="px-4 py-2.5">Empresa</th>
                  <th className="px-4 py-2.5">Máquinas</th>
                  <th className="px-4 py-2.5">Online</th>
                  <th className="px-4 py-2.5">Offline</th>
                  <th className="px-4 py-2.5">Deptos</th>
                  <th className="px-4 py-2.5 w-40">% Online</th>
                  <th className="px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {empresas.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-xs text-zinc-500">Nenhuma empresa cadastrada.</td></tr>
                ) : (relEmpresa ? empresas.filter((e) => e.id === relEmpresa) : empresas).map((emp) => {
                  const ms = maquinasDaEmpresa(emp.id);
                  const on = ms.filter((m) => m.online).length;
                  const pct = ms.length ? Math.round((on / ms.length) * 100) : 0;
                  const statusBadge = pct >= 80
                    ? { cls: "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20", label: "Saudável" }
                    : pct >= 50
                    ? { cls: "bg-amber-500/15 text-amber-400 border border-amber-500/20", label: "Atenção" }
                    : { cls: "bg-red-500/15 text-red-400 border border-red-500/20", label: "Crítico" };
                  return (
                    <tr key={emp.id} className="border-b border-zinc-900/60 hover:bg-zinc-900/20">
                      <td className="px-4 py-2.5 text-white font-semibold">{emp.nome}</td>
                      <td className="px-4 py-2.5 text-zinc-300 font-mono">{ms.length}</td>
                      <td className="px-4 py-2.5 text-emerald-400 font-mono">{on}</td>
                      <td className="px-4 py-2.5 text-zinc-400 font-mono">{ms.length - on}</td>
                      <td className="px-4 py-2.5 text-zinc-400 font-mono">{departamentosDe(emp.id).length}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                            <div className="h-full barra-print rounded-full" style={{ width: pct + "%", background: pct >= 80 ? "#10b981" : pct >= 50 ? "#f59e0b" : "#ef4444" }} />
                          </div>
                          <span className="text-[10px] text-zinc-400 font-mono w-8">{pct}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${statusBadge.cls}`}>
                          {statusBadge.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Disponibilidade (SLA) */}
          <div className="glass-panel rounded-2xl border border-zinc-800 overflow-hidden">
            <div className="px-4 py-3 flex items-center justify-between border-b border-zinc-800">
              <span className="text-sm font-bold text-white">📶 Disponibilidade (SLA) · últimos 30 dias</span>
              <button onClick={carregarUptime} className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs font-semibold text-zinc-300 cursor-pointer no-print">{uptimeDados ? "↻ Atualizar" : "Carregar"}</button>
            </div>
            <div className="p-4 space-y-2">
              {!uptimeDados ? <p className="text-xs text-zinc-500">Clique em "Carregar". A disponibilidade é medida a partir de quando o registro começou (hoje em diante).</p> :
              (idsEmpresa ? uptimeDados.filter((u) => idsEmpresa.has(u.id)) : uptimeDados).length === 0 ? <p className="text-xs text-zinc-500">Sem máquinas.</p> :
              (idsEmpresa ? uptimeDados.filter((u) => idsEmpresa.has(u.id)) : uptimeDados).map((u) => {
                const pct = u.uptime;
                const cor = pct == null ? "#52525b" : pct >= 99 ? "#10b981" : pct >= 95 ? "#84cc16" : pct >= 90 ? "#f59e0b" : "#ef4444";
                return (
                  <div key={u.id} className="flex items-center gap-3">
                    <span className="text-xs text-zinc-300 w-40 truncate">{u.apelido || u.hostname}</span>
                    <div className="flex-1 h-3 rounded-full bg-zinc-800 overflow-hidden"><div className="h-full barra-print rounded-full" style={{ width: (pct ?? 0) + "%", background: cor }}></div></div>
                    <span className="text-xs font-mono w-14 text-right" style={{ color: cor }}>{pct == null ? "—" : pct + "%"}</span>
                  </div>
                );
              })}
              {uptimeDados && <p className="text-[10px] text-zinc-600 mt-2">"—" = ainda sem histórico (a coleta começou agora). Vai ficar preciso com o passar dos dias.</p>}
            </div>
          </div>

          {/* Últimas ações (auditoria) */}
          <div className="glass-panel rounded-2xl border border-zinc-800 overflow-hidden">
            <div className="px-4 py-3 text-sm font-bold text-white border-b border-zinc-800">Últimas ações (auditoria)</div>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] text-zinc-500 uppercase tracking-wider border-b border-zinc-800"><th className="px-4 py-2.5">Quando</th><th className="px-4 py-2.5">Usuário</th><th className="px-4 py-2.5">Máquina</th><th className="px-4 py-2.5">Ação</th><th className="px-4 py-2.5">Status</th></tr></thead>
              <tbody>
                {acoes.length === 0 ? <tr><td colSpan={5} className="px-4 py-8 text-center text-xs text-zinc-500">Nenhuma ação registrada.</td></tr> :
                acoes.map((a) => (
                  <tr key={a.id} className="border-b border-zinc-900/60 hover:bg-zinc-900/20">
                    <td className="px-4 py-2 text-zinc-400 text-xs whitespace-nowrap">{new Date(a.executadoEm).toLocaleString()}</td>
                    <td className="px-4 py-2 text-zinc-300 text-xs">{a.usuarioEmail || "—"}</td>
                    <td className="px-4 py-2 text-zinc-300 text-xs">{a.maquinaApelido || a.maquinaHostname || "—"}</td>
                    <td className="px-4 py-2 text-zinc-300 text-xs">{a.servicoNome}: {a.acaoExecutada}</td>
                    <td className="px-4 py-2 text-xs"><span className={a.statusResultado === "SUCESSO" ? "text-emerald-400" : a.statusResultado === "FALHA" ? "text-red-400" : "text-zinc-400"}>{a.statusResultado}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>)}

          {relAba === "auditoria" && (
            <div className="space-y-4">
              <div className="hidden print:block mb-2">{user?.marca?.logoUrl ? <img src={user.marca.logoUrl} alt="" style={{ maxHeight: 50, marginBottom: 6 }} /> : null}<h1 className="text-xl font-bold">{user?.marca?.nome || "Nexus RMM"} — Relatório de Rastreabilidade</h1><p className="text-xs">Gerado em {new Date().toLocaleString()}</p></div>
              {/* Filtros */}
              <div className="glass-panel rounded-2xl p-4 border border-zinc-800 flex flex-wrap items-end gap-3 no-print">
                <div><label className="block text-[10px] text-zinc-500 mb-1">De</label><input type="date" value={audFiltros.de} onChange={(e) => setAudFiltros({ ...audFiltros, de: e.target.value })} className="px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200" /></div>
                <div><label className="block text-[10px] text-zinc-500 mb-1">Até</label><input type="date" value={audFiltros.ate} onChange={(e) => setAudFiltros({ ...audFiltros, ate: e.target.value })} className="px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200" /></div>
                <div><label className="block text-[10px] text-zinc-500 mb-1">Máquina</label><select value={audFiltros.maquinaId} onChange={(e) => setAudFiltros({ ...audFiltros, maquinaId: e.target.value })} className="px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 max-w-[180px]"><option value="">Todas</option>{maquinasList.map((m) => <option key={m.id} value={m.id}>{m.apelido || m.hostname}</option>)}</select></div>
                <div><label className="block text-[10px] text-zinc-500 mb-1">Status</label><select value={audFiltros.status} onChange={(e) => setAudFiltros({ ...audFiltros, status: e.target.value })} className="px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200"><option value="">Todos</option><option value="SUCESSO">Sucesso</option><option value="FALHA">Falha</option><option value="INICIADO">Iniciado</option></select></div>
                <div className="flex-1 min-w-[140px]"><label className="block text-[10px] text-zinc-500 mb-1">Buscar</label><input value={audFiltros.q} onChange={(e) => setAudFiltros({ ...audFiltros, q: e.target.value })} placeholder="serviço, ação…" className="w-full px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200" /></div>
                <button onClick={() => carregarAuditoria(0)} className="px-4 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-xs font-bold text-emerald-300 cursor-pointer">🔎 Filtrar</button>
                <button onClick={() => window.print()} className="px-3 py-1.5 rounded-lg bg-violet-500/10 border border-violet-500/30 text-xs font-bold text-violet-300 cursor-pointer">🖨️ PDF</button>
                <button onClick={exportarAuditoriaCsv} className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs font-bold text-zinc-300 cursor-pointer">📥 CSV</button>
              </div>
              {/* Tabela */}
              <div className="glass-panel rounded-2xl border border-zinc-800 overflow-hidden">
                <div className="px-4 py-2.5 text-xs text-zinc-400 border-b border-zinc-800 flex justify-between"><span>Eventos de rastreabilidade</span><span>{auditoria ? `${auditoria.total} no total` : ""}</span></div>
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] text-zinc-500 uppercase tracking-wider border-b border-zinc-800"><th className="px-4 py-2.5">Quando</th><th className="px-4 py-2.5">Usuário</th><th className="px-4 py-2.5">Máquina</th><th className="px-4 py-2.5">Tipo</th><th className="px-4 py-2.5">Ação</th><th className="px-4 py-2.5">Status</th></tr></thead>
                  <tbody>
                    {carregandoAud ? <tr><td colSpan={6} className="px-4 py-8 text-center text-xs text-zinc-500">Carregando…</td></tr> :
                    !(auditoria?.itens || []).length ? <tr><td colSpan={6} className="px-4 py-8 text-center text-xs text-zinc-500">Nenhum evento no filtro.</td></tr> :
                    auditoria!.itens.map((a) => (
                      <tr key={a.id} className="border-b border-zinc-900/60 hover:bg-zinc-900/20">
                        <td className="px-4 py-2 text-zinc-400 text-xs whitespace-nowrap">{new Date(a.em).toLocaleString()}</td>
                        <td className="px-4 py-2 text-zinc-300 text-xs">{a.usuario || "—"}</td>
                        <td className="px-4 py-2 text-zinc-300 text-xs">{a.apelido || a.hostname || "—"}</td>
                        <td className="px-4 py-2 text-zinc-400 text-xs">{a.tipo}</td>
                        <td className="px-4 py-2 text-zinc-300 text-xs">{a.acao}{a.detalhe ? <span className="text-red-400/70"> · {a.detalhe}</span> : null}</td>
                        <td className="px-4 py-2 text-xs"><span className={a.status === "SUCESSO" ? "text-emerald-400" : a.status === "FALHA" ? "text-red-400" : "text-amber-400"}>{a.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {auditoria && auditoria.total > auditoria.limite && (
                  <div className="flex justify-between items-center px-4 py-3 border-t border-zinc-800 no-print">
                    <button disabled={audPagina === 0} onClick={() => carregarAuditoria(audPagina - 1)} className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-300 disabled:opacity-40 cursor-pointer">← Anterior</button>
                    <span className="text-[11px] text-zinc-500">Página {audPagina + 1} de {Math.ceil(auditoria.total / auditoria.limite)}</span>
                    <button disabled={(audPagina + 1) * auditoria.limite >= auditoria.total} onClick={() => carregarAuditoria(audPagina + 1)} className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-300 disabled:opacity-40 cursor-pointer">Próxima →</button>
                  </div>
                )}
              </div>
            </div>
          )}

          {relAba === "inventario" && (
            <div className="space-y-4">
              <div className="hidden print:block mb-2">{user?.marca?.logoUrl ? <img src={user.marca.logoUrl} alt="" style={{ maxHeight: 50, marginBottom: 6 }} /> : null}<h1 className="text-xl font-bold">{user?.marca?.nome || "Nexus RMM"} — Inventário de Ativos{nomeEmpresaFiltro ? ` · ${nomeEmpresaFiltro}` : ""}</h1><p className="text-xs">Gerado em {new Date().toLocaleString()}</p></div>
              <div className="flex justify-between items-center no-print">
                <span className="text-xs text-zinc-500">{invConsolidado ? `${(idsEmpresa ? invConsolidado.filter((i) => idsEmpresa.has(i.id)) : invConsolidado).length} máquinas${nomeEmpresaFiltro ? " · " + nomeEmpresaFiltro : ""}` : "carregando…"}</span>
                <div className="flex gap-2">
                  <button onClick={carregarInvConsolidado} className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs font-semibold text-zinc-300 cursor-pointer">↻ Atualizar</button>
                  <button onClick={() => window.print()} className="px-3 py-1.5 rounded-lg bg-violet-500/10 border border-violet-500/30 text-xs font-bold text-violet-300 cursor-pointer">🖨️ PDF</button>
                  <button onClick={exportarInvCsv} className="px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs font-bold text-emerald-300 cursor-pointer">📥 CSV</button>
                </div>
              </div>
              <div className="glass-panel rounded-2xl border border-zinc-800 overflow-x-auto">
                <table className="w-full text-sm min-w-[900px]">
                  <thead><tr className="text-left text-[11px] text-zinc-500 uppercase tracking-wider border-b border-zinc-800"><th className="px-3 py-2.5">Máquina</th><th className="px-3 py-2.5">Status</th><th className="px-3 py-2.5">SO</th><th className="px-3 py-2.5">CPU</th><th className="px-3 py-2.5">RAM</th><th className="px-3 py-2.5">Disco</th><th className="px-3 py-2.5">Softwares</th></tr></thead>
                  <tbody>
                    {!invConsolidado ? <tr><td colSpan={7} className="px-4 py-8 text-center text-xs text-zinc-500">Carregando…</td></tr> :
                    (idsEmpresa ? invConsolidado.filter((i) => idsEmpresa.has(i.id)) : invConsolidado).length === 0 ? <tr><td colSpan={7} className="px-4 py-8 text-center text-xs text-zinc-500">Sem máquinas.</td></tr> :
                    (idsEmpresa ? invConsolidado.filter((i) => idsEmpresa.has(i.id)) : invConsolidado).map((i) => (
                      <tr key={i.id} className="border-b border-zinc-900/60 hover:bg-zinc-900/20">
                        <td className="px-3 py-2 text-white font-semibold text-xs">{i.apelido || i.hostname}</td>
                        <td className="px-3 py-2 text-xs"><span className={`inline-flex items-center gap-1 ${i.online ? "text-emerald-400" : "text-zinc-500"}`}><span className={`w-1.5 h-1.5 rounded-full ${i.online ? "bg-emerald-500" : "bg-zinc-600"}`}></span>{i.online ? "Online" : "Offline"}</span></td>
                        <td className="px-3 py-2 text-zinc-300 text-xs">{i.so || "—"}</td>
                        <td className="px-3 py-2 text-zinc-400 text-xs">{i.cpu || "—"}</td>
                        <td className="px-3 py-2 text-zinc-300 text-xs font-mono">{i.ramGB ? i.ramGB + " GB" : "—"}</td>
                        <td className="px-3 py-2 text-zinc-300 text-xs font-mono">{i.discoTotalGB ? `${i.discoLivreGB ?? "?"}/${i.discoTotalGB} GB livre` : "—"}</td>
                        <td className="px-3 py-2 text-zinc-400 text-xs font-mono">{i.softwares || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {relAba === "manutencoes" && (
            <div className="space-y-4">
              <div className="hidden print:block mb-2">{user?.marca?.logoUrl ? <img src={user.marca.logoUrl} alt="" style={{ maxHeight: 50, marginBottom: 6 }} /> : null}<h1 className="text-xl font-bold">{user?.marca?.nome || "Nexus RMM"} — Relatório de Manutenções</h1><p className="text-xs">Gerado em {new Date().toLocaleString()}</p></div>
              <div className="flex justify-between items-center no-print">
                <span className="text-xs text-zinc-500">{manutReport ? `${manutReport.recentes.length} manutenções · ${manutReport.preventivas.length} preventivas` : "carregando…"}</span>
                <div className="flex gap-2">
                  <button onClick={carregarManutReport} className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs font-semibold text-zinc-300 cursor-pointer">↻ Atualizar</button>
                  <button onClick={() => window.print()} className="px-3 py-1.5 rounded-lg bg-violet-500/10 border border-violet-500/30 text-xs font-bold text-violet-300 cursor-pointer">🖨️ PDF</button>
                  <button onClick={exportarManutCsv} className="px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs font-bold text-emerald-300 cursor-pointer">📥 CSV</button>
                </div>
              </div>
              {manutReport && (manutReport.custos || []).length > 0 && (
                <div className="glass-panel rounded-2xl border border-zinc-800 overflow-hidden">
                  <div className="px-4 py-3 flex justify-between items-center border-b border-zinc-800">
                    <span className="text-sm font-bold text-white">💰 Custo de manutenção (acumulado)</span>
                    <span className="text-lg font-bold text-amber-400 font-mono">R$ {(manutReport.custoTotal || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div className="p-4 grid md:grid-cols-2 gap-5">
                    <div>
                      <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">Por empresa</div>
                      {empresas.map((emp) => {
                        const ids = new Set(maquinasDaEmpresa(emp.id).map((m: any) => m.id));
                        const total = (manutReport!.custos || []).filter((c: any) => ids.has(c.maquinaId)).reduce((s: number, c: any) => s + c.total, 0);
                        if (total <= 0) return null;
                        return <div key={emp.id} className="flex justify-between text-xs py-1 border-b border-zinc-900/60"><span className="text-zinc-300">{emp.nome}</span><span className="text-amber-400/90 font-mono">R$ {total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</span></div>;
                      })}
                    </div>
                    <div>
                      <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">Por máquina (top 10)</div>
                      {(manutReport.custos || []).filter((c: any) => c.total > 0).slice(0, 10).map((c: any) => (
                        <div key={c.maquinaId} className="flex justify-between text-xs py-1 border-b border-zinc-900/60"><span className="text-zinc-300 truncate">{c.nome} <span className="text-zinc-600">· {c.qtd}x</span></span><span className="text-amber-400/90 font-mono shrink-0 ml-2">R$ {c.total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</span></div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <div className="glass-panel rounded-2xl border border-zinc-800 overflow-hidden">
                <div className="px-4 py-3 text-sm font-bold text-white border-b border-zinc-800">📅 Preventivas agendadas</div>
                <div className="p-4 space-y-2">
                  {!manutReport ? <p className="text-xs text-zinc-500">Carregando…</p> :
                  manutReport.preventivas.length === 0 ? <p className="text-xs text-zinc-500">Nenhuma preventiva agendada. Agende na aba 🔧 Manutenção de cada máquina.</p> :
                  manutReport.preventivas.map((p) => {
                    const dias = Math.ceil((new Date(p.proxima).getTime() - Date.now()) / 86400000);
                    const cor = dias < 0 ? "text-red-400" : dias <= 15 ? "text-amber-400" : "text-emerald-400";
                    const lbl = dias < 0 ? `⚠️ vencida há ${-dias}d` : dias === 0 ? "📍 hoje" : `em ${dias}d`;
                    return (
                      <div key={p.id} className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-zinc-900/40 border border-zinc-800/60">
                        <div className="min-w-0"><span className="text-sm text-white">{p.apelido || p.hostname || "—"}</span>{p.descricao ? <span className="text-[11px] text-zinc-500 ml-2">{p.descricao}</span> : null}</div>
                        <div className="text-right shrink-0"><div className="text-xs text-zinc-300">{new Date(p.proxima).toLocaleDateString()}</div><div className={`text-[10px] font-bold ${cor}`}>{lbl}</div></div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="glass-panel rounded-2xl border border-zinc-800 overflow-x-auto">
                <div className="px-4 py-3 text-sm font-bold text-white border-b border-zinc-800 flex items-center gap-2">
                  <svg className="w-3.5 h-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                  </svg>
                  Histórico de manutenções
                </div>
                <table className="w-full text-sm min-w-[820px]">
                  <thead><tr className="text-left text-[11px] text-zinc-500 uppercase tracking-wider border-b border-zinc-800"><th className="px-3 py-2.5">Data</th><th className="px-3 py-2.5">Máquina</th><th className="px-3 py-2.5">Tipo</th><th className="px-3 py-2.5">Descrição</th><th className="px-3 py-2.5">Peças</th><th className="px-3 py-2.5">Técnico</th><th className="px-3 py-2.5">Custo</th></tr></thead>
                  <tbody>
                    {!manutReport ? <tr><td colSpan={7} className="px-4 py-8 text-center text-xs text-zinc-500">Carregando…</td></tr> :
                    manutReport.recentes.length === 0 ? <tr><td colSpan={7} className="px-4 py-8 text-center text-xs text-zinc-500">Nenhuma manutenção registrada.</td></tr> :
                    manutReport.recentes.map((m) => {
                      const cor = m.tipo === "preventiva" ? "text-emerald-400" : m.tipo === "corretiva" ? "text-red-400" : "text-cyan-400";
                      return (
                        <tr key={m.id} className="border-b border-zinc-900/60 hover:bg-zinc-900/20">
                          <td className="px-3 py-2 text-zinc-400 text-xs whitespace-nowrap">{new Date(m.data).toLocaleDateString()}</td>
                          <td className="px-3 py-2 text-white text-xs font-semibold">{m.apelido || m.hostname || "—"}</td>
                          <td className={`px-3 py-2 text-xs font-bold ${cor}`}>{String(m.tipo).toUpperCase()}</td>
                          <td className="px-3 py-2 text-zinc-300 text-xs">{m.descricao}</td>
                          <td className="px-3 py-2 text-zinc-400 text-xs">{m.pecas || "—"}</td>
                          <td className="px-3 py-2 text-zinc-400 text-xs">{m.tecnico || "—"}</td>
                          <td className="px-3 py-2 text-amber-400/80 text-xs font-mono">{m.custo ? "R$ " + m.custo : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* G) SLA de disponibilidade */}
          {relAba === "sla" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-white">📶 SLA de Disponibilidade por Máquina</h3>
                <div className="flex items-center gap-3">
                  <select value={slaDias} onChange={(e) => { const v = parseInt(e.target.value); setSlaDias(v); carregarSla(v); }} className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-300 cursor-pointer">
                    <option value={7}>7 dias</option>
                    <option value={30}>30 dias</option>
                    <option value={60}>60 dias</option>
                    <option value={90}>90 dias</option>
                  </select>
                  <button onClick={() => carregarSla(slaDias)} disabled={carregandoSla} className="text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer disabled:opacity-40">
                    {carregandoSla ? "⌛" : "↺"} atualizar
                  </button>
                </div>
              </div>
              {carregandoSla ? (
                <div className="flex items-center justify-center py-12 gap-2">
                  <div className="w-4 h-4 border-2 border-zinc-800 border-t-emerald-500 rounded-full animate-spin" />
                  <span className="text-xs text-zinc-500">Calculando SLA…</span>
                </div>
              ) : !slaDados ? (
                <p className="text-xs text-zinc-500">Clique em "atualizar" para calcular o SLA.</p>
              ) : slaDados.empresas.length === 0 ? (
                <p className="text-xs text-zinc-500">Nenhuma máquina encontrada.</p>
              ) : (
                slaDados.empresas.map((emp: any) => (
                  <div key={emp.empresa} className="glass-panel rounded-2xl p-4 border border-zinc-800">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-sm font-bold text-white flex items-center gap-2">
                        <svg className="w-3.5 h-3.5 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18M6 21V7l6-4 6 4v14"/><path d="M9 21v-4h6v4"/></svg>
                        {emp.empresa}
                      </h4>
                      <div className={`text-xs font-bold px-2 py-0.5 rounded-full ${emp.avgUptime >= 99 ? "bg-emerald-500/15 text-emerald-300" : emp.avgUptime >= 95 ? "bg-amber-500/15 text-amber-300" : "bg-red-500/15 text-red-300"}`}>
                        Média: {emp.avgUptime}%
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-zinc-500 text-[10px] uppercase">
                            <th className="text-left pb-2 pr-4">Máquina</th>
                            <th className="text-right pb-2 pr-4">Uptime</th>
                            <th className="text-center pb-2 pr-4">SLA 99%</th>
                            <th className="text-left pb-2">Status atual</th>
                          </tr>
                        </thead>
                        <tbody>
                          {emp.itens.map((it: any) => (
                            <tr key={it.id} className="border-t border-zinc-800/40">
                              <td className="py-2 pr-4 text-zinc-300 font-semibold">{it.nome}</td>
                              <td className="py-2 pr-4 text-right">
                                <div className="flex items-center justify-end gap-2">
                                  <div className="w-16 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                                    <div className="h-full rounded-full" style={{ width: `${Math.min(100, it.uptimePct)}%`, background: it.uptimePct >= 99 ? "#10b981" : it.uptimePct >= 95 ? "#f59e0b" : "#ef4444" }}></div>
                                  </div>
                                  <span className={`font-mono font-bold w-12 text-right ${it.uptimePct >= 99 ? "text-emerald-400" : it.uptimePct >= 95 ? "text-amber-400" : "text-red-400"}`}>{it.uptimePct}%</span>
                                </div>
                              </td>
                              <td className="py-2 pr-4 text-center">{it.slaOk ? <svg className="w-3.5 h-3.5 text-emerald-400 inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> : <svg className="w-3.5 h-3.5 text-red-400 inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>}</td>
                              <td className="py-2"><span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${it.online ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-800 text-zinc-500"}`}>{it.online ? "Online" : "Offline"}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </main>
        );
      })()}

      {/* CONTAS / TENANTS (super admin) */}
      {secao === "tenants" && (
        <main className="max-w-5xl w-full mx-auto p-4 md:p-6 space-y-5">
          {resumoPlataforma && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { l: "Clientes (contas)", v: resumoPlataforma.tenants, sub: `${resumoPlataforma.tenantsAtivos} ativos`, c: "text-white" },
                { l: "Clientes conectados", v: resumoPlataforma.tenantsComMaquinaOnline, sub: "com máquina online", c: "text-emerald-400" },
                { l: "Máquinas no servidor", v: resumoPlataforma.maquinas, sub: "total cadastradas", c: "text-white" },
                { l: "Máquinas online", v: resumoPlataforma.maquinasOnline, sub: "conectadas agora", c: "text-emerald-400" },
              ].map((k) => (
                <div key={k.l} className="glass-panel rounded-xl p-4 border border-zinc-800">
                  <div className="text-[10px] text-zinc-500 uppercase tracking-wider">{k.l}</div>
                  <div className={`text-2xl font-bold font-mono ${k.c}`}>{k.v}</div>
                  <div className="text-[10px] text-zinc-600">{k.sub}</div>
                </div>
              ))}
            </div>
          )}
          {resumoPlataforma && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="glass-panel rounded-xl p-4 border border-emerald-500/30">
                <div className="text-[10px] text-zinc-500 uppercase tracking-wider">💰 MRR (receita recorrente/mês)</div>
                <div className="text-3xl font-bold font-mono text-emerald-400">R$ {(resumoPlataforma.mrr || 0).toLocaleString("pt-BR")}</div>
                <div className="text-[10px] text-zinc-600">soma dos planos pagos ativos</div>
              </div>
              <div className="glass-panel rounded-xl p-4 border border-zinc-800">
                <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Clientes pagantes</div>
                <div className="text-3xl font-bold font-mono text-white">{resumoPlataforma.pagantes || 0}</div>
                <div className="text-[10px] text-zinc-600">em plano pago</div>
              </div>
              <div className="glass-panel rounded-xl p-4 border border-zinc-800">
                <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Em trial (converter!)</div>
                <div className="text-3xl font-bold font-mono text-amber-400">{resumoPlataforma.trials || 0}</div>
                <div className="text-[10px] text-zinc-600">oportunidades de venda</div>
              </div>
            </div>
          )}
          <div className="flex justify-end"><button onClick={abrirTenants} className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-400 hover:text-white cursor-pointer">↻ Atualizar</button></div>
          <div className="glass-panel rounded-2xl p-5 border border-violet-500/30 space-y-3">
            <h3 className="text-sm font-bold text-white">➕ Criar conta de cliente (espaço isolado)</h3>
            <p className="text-[11px] text-zinc-500">Quem comprou o sistema pra gerenciar a própria frota. O cliente recebe um espaço <b>100% separado</b> — só os dados dele, ele vira o dono (owner). Loga com o e-mail/senha abaixo.</p>
            <div className="grid md:grid-cols-2 gap-2">
              <input value={novoTenant.nome} onChange={(e) => setNovoTenant({ ...novoTenant, nome: e.target.value })} placeholder="Nome da empresa do cliente" className="px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm" />
              <select value={novoTenant.plano} onChange={(e) => setNovoTenant({ ...novoTenant, plano: e.target.value })} className="px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm cursor-pointer">
                <option value="trial">Plano: Trial (3 máq.)</option><option value="essencial">Plano: Essencial (25)</option><option value="pro">Plano: Pro (150)</option><option value="enterprise">Plano: Enterprise (∞)</option>
              </select>
              <input value={novoTenant.ownerEmail} onChange={(e) => setNovoTenant({ ...novoTenant, ownerEmail: e.target.value })} placeholder="E-mail de login do cliente" className="px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm" />
              <input type="password" value={novoTenant.ownerSenha} onChange={(e) => setNovoTenant({ ...novoTenant, ownerSenha: e.target.value })} placeholder="Senha inicial (mín. 8)" className="px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm" />
            </div>
            <button onClick={criarTenant} className="px-4 py-2 rounded-lg bg-violet-500/15 border border-violet-500/30 text-xs font-bold text-violet-300 cursor-pointer">Criar conta (exige seu MFA)</button>
          </div>

          <div className="glass-panel rounded-2xl border border-zinc-800 overflow-x-auto">
            <div className="px-4 py-3 text-sm font-bold text-white border-b border-zinc-800">Contas ({tenantsList?.length || 0})</div>
            <table className="w-full text-sm min-w-[700px]">
              <thead><tr className="text-left text-[11px] text-zinc-500 uppercase tracking-wider border-b border-zinc-800"><th className="px-4 py-2.5">Empresa</th><th className="px-4 py-2.5">Dono (login)</th><th className="px-4 py-2.5">Plano</th><th className="px-4 py-2.5">Máquinas</th><th className="px-4 py-2.5">Criado</th><th className="px-4 py-2.5">Ações</th></tr></thead>
              <tbody>
                {!tenantsList ? <tr><td colSpan={6} className="px-4 py-8 text-center text-xs text-zinc-500">Carregando…</td></tr> :
                tenantsList.map((t) => (
                  <tr key={t.id} className="border-b border-zinc-900/60 hover:bg-zinc-900/20">
                    <td className="px-4 py-2.5 text-white font-semibold">{t.nome}{!t.ativo && <span className="text-red-400 text-[10px] ml-1">(inativo)</span>}</td>
                    <td className="px-4 py-2.5 text-zinc-300 text-xs">{t.owner || "—"}</td>
                    <td className="px-4 py-2.5"><select value={t.plano} onChange={(e) => mudarPlanoTenant(t.id, e.target.value)} className="px-2 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 cursor-pointer"><option value="trial">Trial</option><option value="essencial">Essencial</option><option value="pro">Pro</option><option value="enterprise">Enterprise</option></select></td>
                    <td className="px-4 py-2.5 font-mono text-xs"><span className="text-emerald-400">{t.online}</span><span className="text-zinc-600"> / {t.maquinas}</span> <span className="text-[10px] text-zinc-600">online</span></td>
                    <td className="px-4 py-2.5 text-zinc-500 text-xs">{t.criadoEm ? new Date(t.criadoEm).toLocaleDateString() : "—"}</td>
                    <td className="px-4 py-2.5">
                      {t.slug !== "gmtec" && (
                        <div className="flex gap-1.5">
                          <button onClick={() => resetMfaTenant(t.id, t.owner)} className="px-2 py-1 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[10px] font-semibold text-amber-300 hover:text-amber-200 cursor-pointer" title="Resetar MFA do dono">Reset MFA</button>
                          <button onClick={() => resetSenhaTenant(t.id, t.owner)} className="px-2 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-[10px] font-semibold text-zinc-400 hover:text-white cursor-pointer" title="Resetar senha do dono">Reset senha</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </main>
      )}

      {/* PLANOS & COBRANÇA */}
      {secao === "planos" && (
        <main className="max-w-6xl w-full mx-auto p-4 md:p-6 space-y-5">
          {!planoInfo ? <p className="text-xs text-zinc-500">Carregando…</p> : (<>
            <div className="glass-panel rounded-2xl p-5 border border-emerald-500/30">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Plano atual</div>
                  <div className="text-2xl font-bold text-emerald-300">{planoInfo.info.nome}</div>
                  <div className="text-xs text-zinc-500">{planoInfo.info.precoMes == null ? "sob consulta" : planoInfo.info.precoMes === 0 ? "grátis" : `R$ ${planoInfo.info.precoMes}/mês`}</div>
                  {user?.acesso?.motivo && user.acesso.diasRestantes >= 0 && <div className="text-[11px] text-amber-400 mt-1">{user.acesso.motivo === "trial" ? `Teste: faltam ${user.acesso.diasRestantes} dia(s)` : `Renova em ${user.acesso.diasRestantes} dia(s)`}</div>}
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Máquinas</div>
                  <div className="text-xl font-mono text-white">{planoInfo.maquinasUsadas} / {planoInfo.info.maxMaquinas >= 100000 ? "∞" : planoInfo.info.maxMaquinas}</div>
                </div>
              </div>
              <div className="h-2 rounded-full bg-zinc-800 overflow-hidden mt-3"><div className="h-full bg-emerald-500 rounded-full" style={{ width: Math.min(100, (planoInfo.maquinasUsadas / planoInfo.info.maxMaquinas) * 100) + "%" }}></div></div>
              {planoInfo.maquinasUsadas >= planoInfo.info.maxMaquinas && <p className="text-[11px] text-amber-400 mt-2">⚠️ Limite atingido — novas máquinas serão bloqueadas no cadastro. Faça upgrade.</p>}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {Object.entries(planoInfo.planos).map(([id, pl]: any) => (
                <div key={id} className={`glass-panel rounded-2xl p-4 border flex flex-col ${id === planoInfo.plano ? "border-emerald-500/50" : "border-zinc-800"}`}>
                  <div className="text-sm font-bold text-white">{pl.nome}</div>
                  <div className="text-2xl font-bold text-emerald-300 my-1">{pl.precoMes == null ? <span className="text-base">sob consulta</span> : pl.precoMes === 0 ? "Grátis" : <>R$ {pl.precoMes}<span className="text-xs text-zinc-500">/mês</span></>}</div>
                  <div className="text-[11px] text-zinc-500 mb-2">{pl.maxMaquinas >= 100000 ? "Máquinas ilimitadas" : `Até ${pl.maxMaquinas} máquinas`}</div>
                  <ul className="space-y-1 text-[11px] flex-1">
                    {Object.entries(planoInfo.featuresLabel).map(([f, lbl]: any) => (
                      <li key={f} className={pl.features.includes(f) ? "text-zinc-300" : "text-zinc-700 line-through"}>{pl.features.includes(f) ? "✓" : "✗"} {lbl}</li>
                    ))}
                  </ul>
                  {user?.superAdmin ? (
                    id === planoInfo.plano ? <div className="mt-3 text-center text-[11px] text-emerald-400 font-bold py-2">✓ Plano atual</div> : <button onClick={() => trocarPlano(id)} className="mt-3 px-3 py-2 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-xs font-bold text-emerald-300 cursor-pointer">Selecionar</button>
                  ) : id === planoInfo.plano ? (
                    <div className="mt-3 text-center text-[11px] text-emerald-400 font-bold py-2">✓ Seu plano</div>
                  ) : (id === "essencial" || id === "pro") ? (
                    <button onClick={() => assinar(id)} className="mt-3 px-3 py-2 rounded-lg text-xs font-bold cursor-pointer" style={{ background: "linear-gradient(90deg,#10b981,#22d3ee)", color: "#04121a" }}>Assinar →</button>
                  ) : null}
                </div>
              ))}
            </div>
            <p className="text-[11px] text-zinc-600">💡 A troca de plano aqui é para teste. O <b>pagamento real</b> (cartão/PIX via Stripe/Mercado Pago) será plugado depois — toda a engine de liberação de features e limites já está funcionando.</p>
          </>)}
        </main>
      )}

      {/* SEGURANÇA */}
      {secao === "seguranca" && (
        <main className="max-w-3xl w-full mx-auto p-4 md:p-6 space-y-4">
          <div className="glass-panel rounded-2xl p-5 border border-zinc-800 space-y-4">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <svg className="w-4 h-4 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
              Configurações de segurança
            </h3>
            <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-900/40 border border-zinc-800/60">
              <div className="pr-4">
                <div className="text-sm text-white flex items-center gap-2">
                  <svg className="w-3.5 h-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                  </svg>
                  Permitir acesso só do Brasil
                </div>
                <div className="text-[11px] text-zinc-500 mt-0.5">Bloqueia acessos de fora do Brasil. Requer Cloudflare na frente do domínio (header CF-IPCountry). Sem Cloudflare, não tem efeito.</div>
              </div>
              <button onClick={() => salvarSeguranca({ apenasBrasil: !segConfig.apenasBrasil })} className={`shrink-0 w-12 h-6 rounded-full relative transition-colors cursor-pointer ${segConfig.apenasBrasil ? "bg-emerald-500" : "bg-zinc-700"}`}><span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${segConfig.apenasBrasil ? "left-6" : "left-0.5"}`}></span></button>
            </div>
            <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-900/40 border border-zinc-800/60">
              <div className="pr-4">
                <div className="text-sm text-white flex items-center gap-2">
                  <svg className="w-3.5 h-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  </svg>
                  Exigir 2FA de todos os usuários
                </div>
                <div className="text-[11px] text-zinc-500 mt-0.5">Reforça que todos configurem e usem o código MFA. (Ações sensíveis já exigem MFA hoje.)</div>
              </div>
              <button onClick={() => salvarSeguranca({ forcar2fa: !segConfig.forcar2fa })} className={`shrink-0 w-12 h-6 rounded-full relative transition-colors cursor-pointer ${segConfig.forcar2fa ? "bg-emerald-500" : "bg-zinc-700"}`}><span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${segConfig.forcar2fa ? "left-6" : "left-0.5"}`}></span></button>
            </div>
          </div>
          <div className="glass-panel rounded-2xl p-5 border border-zinc-800 space-y-3">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <svg className="w-4 h-4 text-violet-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="13.5" cy="6.5" r="0.5" fill="currentColor"/><circle cx="17.5" cy="10.5" r="0.5" fill="currentColor"/><circle cx="8.5" cy="7.5" r="0.5" fill="currentColor"/><circle cx="6.5" cy="12.5" r="0.5" fill="currentColor"/>
                <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>
              </svg>
              Marca / Identidade nos relatórios
            </h3>
            <p className="text-[11px] text-zinc-500">Aparece no cabeçalho dos PDFs (relatórios). Deixa profissional pro cliente.</p>
            <div>
              <label className="block text-[10px] text-zinc-500 mb-1">Nome da empresa (sua marca)</label>
              <input value={segConfig.nomeMarca || ""} onChange={(e) => setSegConfig({ ...segConfig, nomeMarca: e.target.value })} placeholder="Ex.: GMTEC Soluções em TI" className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/40" />
            </div>
            <div>
              <label className="block text-[10px] text-zinc-500 mb-1">URL do logo (imagem PNG/JPG)</label>
              <input value={segConfig.logoUrl || ""} onChange={(e) => setSegConfig({ ...segConfig, logoUrl: e.target.value })} placeholder="https://..." className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/40" />
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => salvarSeguranca({ nomeMarca: segConfig.nomeMarca || "", logoUrl: segConfig.logoUrl || "" })} className="px-4 py-2 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-xs font-bold text-emerald-300 cursor-pointer">Salvar marca</button>
              {segConfig.logoUrl ? <img src={segConfig.logoUrl} alt="" style={{ maxHeight: 32 }} className="rounded" /> : null}
              <span className="text-[10px] text-zinc-600">vale ao relogar (o nome viaja no perfil)</span>
            </div>
          </div>
          {/* Regras de alerta + IA remediação */}
          <div className="glass-panel rounded-2xl p-5 border border-zinc-800 space-y-4">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <svg className="w-4 h-4 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93l-1.41 1.41M4.93 19.07l1.41-1.41M20 12h2M2 12h2M19.07 19.07l-1.41-1.41M4.93 4.93l1.41 1.41M12 2v2M12 20v2"/>
              </svg>
              Regras de alerta e IA remediação
            </h3>
            <p className="text-[11px] text-zinc-500">Defina os thresholds de CPU, RAM e disco que disparam alertas. A IA só entra em ação se habilitada aqui <b>e</b> na máquina.</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-[10px] text-zinc-500 mb-1">CPU limite (%)</label>
                <input type="number" min="50" max="100" value={regrasAlerta.cpuLimitePct} onChange={(e) => setRegrasAlerta({...regrasAlerta, cpuLimitePct: Number(e.target.value)})} className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm" />
              </div>
              <div>
                <label className="block text-[10px] text-zinc-500 mb-1">CPU janela (min)</label>
                <input type="number" min="1" max="60" value={regrasAlerta.cpuJanelaMin} onChange={(e) => setRegrasAlerta({...regrasAlerta, cpuJanelaMin: Number(e.target.value)})} className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm" />
              </div>
              <div>
                <label className="block text-[10px] text-zinc-500 mb-1">RAM limite (%)</label>
                <input type="number" min="50" max="100" value={regrasAlerta.ramLimitePct} onChange={(e) => setRegrasAlerta({...regrasAlerta, ramLimitePct: Number(e.target.value)})} className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm" />
              </div>
              <div>
                <label className="block text-[10px] text-zinc-500 mb-1">RAM janela (min)</label>
                <input type="number" min="1" max="60" value={regrasAlerta.ramJanelaMin} onChange={(e) => setRegrasAlerta({...regrasAlerta, ramJanelaMin: Number(e.target.value)})} className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm" />
              </div>
              <div>
                <label className="block text-[10px] text-zinc-500 mb-1">Disco livre mínimo (%)</label>
                <input type="number" min="1" max="50" value={regrasAlerta.discoLivreMinPct} onChange={(e) => setRegrasAlerta({...regrasAlerta, discoLivreMinPct: Number(e.target.value)})} className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm" />
              </div>
            </div>
            <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-900/40 border border-zinc-800/60">
              <div>
                <div className="text-sm text-white flex items-center gap-2">
                  <svg className="w-3.5 h-3.5 text-violet-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/>
                    <circle cx="9" cy="14" r="1" fill="currentColor"/><circle cx="15" cy="14" r="1" fill="currentColor"/>
                  </svg>
                  IA remediação — ativar globalmente
                </div>
                <div className="text-[11px] text-zinc-500 mt-0.5">Permite que a IA atue nas máquinas onde for habilitada individualmente. Quando desligado, a IA não age em nenhuma máquina do tenant.</div>
              </div>
              <button onClick={() => setRegrasAlerta({...regrasAlerta, iaRemediaCaoGlobal: !regrasAlerta.iaRemediaCaoGlobal})} className={`shrink-0 w-12 h-6 rounded-full relative transition-colors cursor-pointer ${regrasAlerta.iaRemediaCaoGlobal ? "bg-emerald-500" : "bg-zinc-700"}`}>
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${regrasAlerta.iaRemediaCaoGlobal ? "left-6" : "left-0.5"}`}></span>
              </button>
            </div>
            <button onClick={salvarRegrasAlerta} disabled={salvandoRegras} className="px-4 py-2 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-xs font-semibold text-emerald-300 cursor-pointer disabled:opacity-50">
              {salvandoRegras ? "Salvando…" : "Salvar regras"}
            </button>
          </div>

          {/* Log de remediações IA */}
          <div className="glass-panel rounded-2xl p-5 border border-zinc-800 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <svg className="w-3.5 h-3.5 text-violet-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                </svg>
                Histórico de remediações IA
              </h3>
              <button onClick={() => { setRemediacoesCarregadas(false); carregarRemediacoesLog(); }} className="text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer">↺ atualizar</button>
            </div>
            {remediacoesLog.length === 0 ? (
              <p className="text-[11px] text-zinc-600 italic">Nenhuma remediação registrada. A IA age automaticamente quando IA Global + máquina estiverem habilitados.</p>
            ) : (
              <div className="space-y-2">
                {remediacoesLog.map((r) => (
                  <div key={r.id} className="p-3 rounded-xl bg-zinc-900/50 border border-zinc-800/60 text-xs space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-zinc-200">{r.maquinaNome || r.maquinaHostname || r.maquinaId}</span>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${r.status === "sucesso" ? "bg-emerald-500/15 text-emerald-300" : r.status === "falha" ? "bg-red-500/15 text-red-300" : "bg-zinc-700/40 text-zinc-400"}`}>{r.status}</span>
                    </div>
                    <p className="text-zinc-400">{r.triggerDescricao}</p>
                    {r.acoesExecutadas && r.acoesExecutadas.length > 0 && (
                      <p className="text-zinc-500">Ações: {r.acoesExecutadas.join(", ")}</p>
                    )}
                    {r.metricasAntes && r.metricasDepois && (
                      <div className="flex gap-4 text-zinc-600">
                        <span>CPU antes: {r.metricasAntes.cpu}% → depois: {r.metricasDepois.cpu}%</span>
                        <span>RAM antes: {r.metricasAntes.ram}% → depois: {r.metricasDepois.ram}%</span>
                      </div>
                    )}
                    <p className="text-zinc-600">{r.duracaoMs ? `${r.duracaoMs}ms` : ""} · {new Date(r.criadoEm).toLocaleString("pt-BR")}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Aprovações de IA pendentes */}
          {temFeature("ia_remediacao") && (
            <div className="glass-panel rounded-2xl p-5 border border-zinc-800 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <svg className="w-3.5 h-3.5 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                  </svg>
                  Aprovações de IA pendentes
                </h3>
                <button onClick={carregarAprovacoesPendentes} className="text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer">↺ atualizar</button>
              </div>
              {aprovacoesPendentes.length === 0 ? (
                <p className="text-[11px] text-zinc-600 italic">Nenhuma aprovação pendente. Quando a IA detectar um problema e precisar de autorização, aparecerá aqui — e você receberá alerta no Telegram/WhatsApp.</p>
              ) : (
                <div className="space-y-3">
                  {aprovacoesPendentes.map((ap) => {
                    const expira = new Date(ap.expiresAt);
                    const restante = Math.max(0, Math.round((expira.getTime() - Date.now()) / 1000));
                    const min = Math.floor(restante / 60);
                    const seg = restante % 60;
                    return (
                      <div key={ap.id} className="p-4 rounded-xl bg-amber-500/5 border border-amber-500/20 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <span className="text-xs font-semibold text-white">{ap.maquinaNome || ap.maquinaId}</span>
                            <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] bg-amber-500/15 text-amber-300 font-bold">{ap.codigo}</span>
                          </div>
                          <span className="text-[10px] text-zinc-500 shrink-0">Expira em {min}m{seg < 10 ? "0" : ""}{seg}s</span>
                        </div>
                        <p className="text-[11px] text-zinc-400">{ap.triggerDescricao}</p>
                        {ap.acoesProposas && ap.acoesProposas.length > 0 && (
                          <div className="text-[11px] text-zinc-500">
                            <span className="text-zinc-400">IA propõe: </span>
                            {ap.acoesProposas.join(" · ")}
                          </div>
                        )}
                        <div className="flex gap-2 pt-1">
                          <button
                            onClick={() => aprovarRemediacao(ap.id)}
                            disabled={!!aprovWh[ap.id]}
                            className="px-4 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-xs font-semibold text-emerald-300 cursor-pointer disabled:opacity-50"
                          >
                            {aprovWh[ap.id] ? "Aguarde…" : "Autorizar"}
                          </button>
                          <button
                            onClick={() => recusarRemediacao(ap.id)}
                            disabled={!!aprovWh[ap.id]}
                            className="px-4 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-xs text-red-300 cursor-pointer disabled:opacity-50"
                          >
                            Cancelar
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className="glass-panel rounded-2xl p-5 border border-zinc-800">
            <h3 className="text-sm font-bold text-white mb-2 flex items-center gap-2">
              <svg className="w-4 h-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              </svg>
              Proteções já ativas
            </h3>
            <ul className="text-xs text-zinc-400 space-y-1 list-disc pl-5">
              <li>TLS + mTLS (cada máquina com certificado próprio)</li>
              <li>Login com MFA + senha Argon2id</li>
              <li>Isolamento por empresa (RLS) + comandos assinados + auditoria imutável</li>
              <li>Anti força-bruta (bloqueio após 8 tentativas)</li>
              <li>Acesso remoto: captura DXGI nativa (sem VNC) + sessão autenticada por JWT efêmero</li>
              <li>Permissão por papel (Leitura = só visualiza)</li>
            </ul>
          </div>
        </main>
      )}

      {/* MÁQUINAS */}
      {secao === "maquinas" && (
      <main className="flex-1 max-w-[1600px] w-full mx-auto p-4 md:p-6 space-y-6">
        
        {/* Stats Cards Section */}
        <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {/* Total */}
          <div className="glass-panel rounded-2xl p-4 border border-zinc-800 hover:border-zinc-700 transition-colors duration-150 group">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Total de Dispositivos</p>
                <h2 className="text-4xl font-extrabold text-white mt-1.5 font-mono leading-none">{totalDispositivos}</h2>
              </div>
              <div className="w-9 h-9 rounded-xl bg-zinc-800/60 border border-zinc-700/50 flex items-center justify-center text-zinc-500 group-hover:text-zinc-300 transition-colors duration-150 shrink-0">
                <svg className="w-4.5 h-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="8" height="6" rx="1"/><rect x="14" y="3" width="8" height="6" rx="1"/>
                  <rect x="2" y="13" width="8" height="6" rx="1"/><rect x="14" y="13" width="8" height="6" rx="1"/>
                </svg>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-1.5">
              <div className="flex-1 h-1 rounded-full bg-zinc-800 overflow-hidden">
                <div className="h-full rounded-full bg-zinc-600 transition-all duration-700" style={{ width: totalDispositivos > 0 ? "100%" : "0%" }} />
              </div>
              <span className="text-[10px] text-zinc-600 font-mono shrink-0">{onlineDispositivos}/{totalDispositivos}</span>
            </div>
          </div>

          {/* Online */}
          <div className="glass-panel rounded-2xl p-4 border border-emerald-500/20 hover:border-emerald-500/40 transition-colors duration-150 bg-emerald-500/[0.03] group">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[10px] font-bold text-emerald-500/70 uppercase tracking-widest flex items-center gap-1.5">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
                  </span>
                  Online
                </p>
                <h2 className="text-4xl font-extrabold text-emerald-400 mt-1.5 font-mono leading-none">{onlineDispositivos}</h2>
              </div>
              <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-500 shrink-0">
                <svg className="w-4.5 h-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9"/><polyline points="9 12 11 14 15 10"/>
                </svg>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-1.5">
              <div className="flex-1 h-1 rounded-full bg-zinc-800 overflow-hidden">
                <div className="h-full rounded-full bg-emerald-500 transition-all duration-700" style={{ width: totalDispositivos > 0 ? `${Math.round((onlineDispositivos / totalDispositivos) * 100)}%` : "0%" }} />
              </div>
              <span className="text-[10px] text-emerald-600 font-mono shrink-0">{totalDispositivos > 0 ? Math.round((onlineDispositivos / totalDispositivos) * 100) : 0}%</span>
            </div>
          </div>

          {/* Offline */}
          <div className={`glass-panel rounded-2xl p-4 border transition-colors duration-150 group ${offlineDispositivos > 0 ? "border-red-500/20 hover:border-red-500/35 bg-red-500/[0.02]" : "border-zinc-800 hover:border-zinc-700"}`}>
            <div className="flex items-start justify-between">
              <div>
                <p className={`text-[10px] font-bold uppercase tracking-widest flex items-center gap-1.5 ${offlineDispositivos > 0 ? "text-red-400/70" : "text-zinc-500"}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${offlineDispositivos > 0 ? "bg-red-500" : "bg-zinc-600"}`}></span>
                  Offline
                </p>
                <h2 className={`text-4xl font-extrabold mt-1.5 font-mono leading-none ${offlineDispositivos > 0 ? "text-red-400" : "text-zinc-600"}`}>{offlineDispositivos}</h2>
              </div>
              <div className={`w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 ${offlineDispositivos > 0 ? "bg-red-500/10 border-red-500/20 text-red-500" : "bg-zinc-800/60 border-zinc-700/50 text-zinc-600"}`}>
                <svg className="w-4.5 h-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>
                </svg>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-1.5">
              <div className="flex-1 h-1 rounded-full bg-zinc-800 overflow-hidden">
                <div className={`h-full rounded-full transition-all duration-700 ${offlineDispositivos > 0 ? "bg-red-500" : "bg-zinc-700"}`} style={{ width: totalDispositivos > 0 ? `${Math.round((offlineDispositivos / totalDispositivos) * 100)}%` : "0%" }} />
              </div>
              <span className={`text-[10px] font-mono shrink-0 ${offlineDispositivos > 0 ? "text-red-600" : "text-zinc-600"}`}>{totalDispositivos > 0 ? Math.round((offlineDispositivos / totalDispositivos) * 100) : 0}%</span>
            </div>
          </div>
        </section>

        {/* Tabela de Dispositivos e Cadastro */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold text-white">Dispositivos Monitorados</h3>
              <p className="text-xs text-zinc-500">Lista e status de presença das máquinas associadas ao seu tenant.</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* Pills de filtro por SO */}
              <div className="flex items-center gap-1">
                {([
                  { key: "windows", label: "Windows", icon: "⊞" },
                  { key: "linux",   label: "Linux",   icon: "🐧" },
                  { key: "macos",   label: "macOS",   icon: "" },
                ] as const).map(({ key, label, icon }) => (
                  <button
                    key={key}
                    onClick={() => setFiltroSO(filtroSO === key ? null : key)}
                    className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors duration-150 cursor-pointer ${
                      filtroSO === key
                        ? "bg-sky-500/15 border-sky-500/40 text-sky-300"
                        : "bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700"
                    }`}
                  >
                    <span>{icon}</span> {label}
                  </button>
                ))}
              </div>
              <div className="relative w-52">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
                </svg>
                <input
                  id="busca-maquinas"
                  type="text"
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  placeholder="Buscar... (pressione /)"
                  className="w-full pl-8 pr-3 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs focus:outline-none focus:border-emerald-500/40 transition-colors duration-150"
                />
              </div>
              <button
                onClick={() => { setPaletteAberta(true); setPaletteQuery(""); setPaletteIdx(0); setTimeout(() => paletteInputRef.current?.focus(), 30); }}
                title="Command Palette (Ctrl+K)"
                className="hidden sm:flex items-center gap-1.5 px-3 py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-500 hover:text-zinc-300 text-xs transition-colors duration-150 cursor-pointer shrink-0"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                <kbd className="font-mono text-[10px] border border-zinc-800 rounded px-1">Ctrl+K</kbd>
              </button>
              <button
                onClick={abrirModalCadastro}
                className="px-5 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-black font-semibold text-xs transition-all glow-emerald cursor-pointer flex items-center gap-1.5 active:scale-98 shrink-0"
              >
                <span>+</span> Cadastrar Máquina
              </button>
            </div>
          </div>

          <div className="flex flex-col lg:flex-row gap-6">
            {/* Sidebar: empresas e departamentos */}
            <aside className={`shrink-0 glass-panel rounded-2xl border border-zinc-800 h-fit transition-all duration-200 ${asideEmpresas ? "lg:w-64 p-3 space-y-1" : "lg:w-10 p-1.5"}`}>
              {/* Header com toggle */}
              <div className={`flex items-center ${asideEmpresas ? "justify-between mb-1" : "justify-center"}`}>
                {asideEmpresas && <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider px-1">Filtrar por empresa</span>}
                <button
                  onClick={() => setAsideEmpresas((v) => !v)}
                  title={asideEmpresas ? "Recolher painel" : "Expandir painel"}
                  className="w-6 h-6 rounded-md flex items-center justify-center text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    {asideEmpresas ? <><path d="M15 18l-6-6 6-6"/></> : <><path d="M9 18l6-6-6-6"/></>}
                  </svg>
                </button>
              </div>
              {asideEmpresas && <>
              <button
                onClick={() => setGrupoSelecionado(null)}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${grupoSelecionado === null ? "bg-emerald-500/15 text-emerald-300" : "text-zinc-400 hover:bg-zinc-800/50"}`}
              >
                Todos os dispositivos
              </button>
              {empresas.map((emp) => (
                <div key={emp.id}>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setGrupoSelecionado(emp.id)}
                      className={`flex-1 text-left px-3 py-2 rounded-lg text-xs font-semibold transition-colors duration-150 flex items-center gap-1.5 ${grupoSelecionado === emp.id ? "bg-emerald-500/15 text-emerald-300" : "text-zinc-300 hover:bg-zinc-800/50"}`}
                    >
                      <svg className="w-3 h-3 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 21h18M6 21V7l6-4 6 4v14"/><path d="M9 21v-4h6v4"/>
                      </svg>
                      {emp.nome}
                    </button>
                    <button
                      onClick={() => criarDepartamento(emp.id)}
                      title="Novo departamento"
                      className="px-2 py-1 rounded-md text-zinc-500 hover:text-emerald-300 hover:bg-zinc-800/50 text-sm cursor-pointer"
                    >
                      +
                    </button>
                  </div>
                  {departamentosDe(emp.id).map((dep) => (
                    <button
                      key={dep.id}
                      onClick={() => setGrupoSelecionado(dep.id)}
                      className={`w-full text-left pl-7 pr-3 py-1.5 rounded-lg text-xs transition-colors ${grupoSelecionado === dep.id ? "bg-emerald-500/15 text-emerald-300" : "text-zinc-400 hover:bg-zinc-800/50"}`}
                    >
                      ↳ {dep.nome}
                    </button>
                  ))}
                </div>
              ))}
              <button
                onClick={criarEmpresa}
                className="w-full text-left px-3 py-2 mt-1 rounded-lg text-xs font-semibold text-emerald-400 hover:bg-emerald-500/10 transition-colors border border-dashed border-zinc-800 cursor-pointer"
              >
                + Nova empresa
              </button>
              </>}
            </aside>

            <div className="flex-1 min-w-0 glass-panel-neon rounded-2xl overflow-hidden border border-zinc-800/80">
            {maquinasFiltradas.length === 0 ? (
              <div className="text-center py-16 px-4 flex flex-col items-center gap-4">
                <div className="w-16 h-16 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center">
                  <svg className="w-8 h-8 text-zinc-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
                    <path d="M7 8h4M7 11h2" strokeOpacity={0.5}/>
                  </svg>
                </div>
                <div>
                  <h4 className="text-sm font-bold text-white">Nenhum dispositivo monitorado</h4>
                  <p className="text-xs text-zinc-500 mt-1 max-w-xs mx-auto leading-relaxed">
                    Instale o agente Nexus em qualquer máquina Windows, Linux ou macOS para começar o monitoramento.
                  </p>
                </div>
                <button onClick={abrirModalCadastro} className="px-4 py-2 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-xs font-semibold text-emerald-300 transition-colors duration-150 cursor-pointer">
                  Cadastrar primeira máquina
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                {selecionadas.size > 0 && (
                  <div className="border-b border-emerald-500/20 bg-emerald-500/5">
                    {/* Header da barra */}
                    <div className="flex items-center gap-3 px-4 py-2.5">
                      <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-300">
                        <span className="w-4 h-4 rounded bg-emerald-500/20 flex items-center justify-center text-[10px] font-bold">{selecionadas.size}</span>
                        selecionada{selecionadas.size !== 1 ? "s" : ""}
                      </span>
                      {/* Tabs */}
                      <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
                        <button onClick={() => setLoteAba("servico")} className={`px-3 py-1 text-[11px] font-semibold transition-colors cursor-pointer ${loteAba === "servico" ? "bg-zinc-800 text-zinc-200" : "text-zinc-500 hover:text-zinc-300"}`}>Serviços</button>
                        <button onClick={() => setLoteAba("comando")} className={`px-3 py-1 text-[11px] font-semibold transition-colors cursor-pointer ${loteAba === "comando" ? "bg-zinc-800 text-zinc-200" : "text-zinc-500 hover:text-zinc-300"}`}>Comando</button>
                      </div>
                      <button onClick={() => { setSelecionadas(new Set()); setResultadosLote(null); }} className="ml-auto text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer">✕ limpar</button>
                    </div>
                    {/* Conteúdo da aba */}
                    {loteAba === "servico" ? (
                      <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
                        <input
                          type="text"
                          placeholder="Nome do serviço (ex.: Spooler)"
                          value={servicoMassa}
                          onChange={(e) => setServicoMassa(e.target.value)}
                          className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs focus:outline-none focus:border-emerald-500/40 min-w-[200px]"
                        />
                        <button onClick={() => executarAcaoMassa("START")} disabled={executandoMassa} className="px-3 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-xs font-semibold text-emerald-300 cursor-pointer disabled:opacity-50">▶ Iniciar</button>
                        <button onClick={() => executarAcaoMassa("STOP")} disabled={executandoMassa} className="px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-xs font-semibold text-red-300 cursor-pointer disabled:opacity-50">⏹ Parar</button>
                        <button onClick={() => executarAcaoMassa("RESTART")} disabled={executandoMassa} className="px-3 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-xs font-semibold text-amber-300 cursor-pointer disabled:opacity-50">↻ Reiniciar</button>
                        {executandoMassa && <span className="text-xs text-zinc-400">executando…</span>}
                      </div>
                    ) : (
                      <div className="px-4 pb-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            placeholder="Comando PowerShell (ex.: Get-Process | Select-Object -First 5)"
                            value={comandoLote}
                            onChange={(e) => setComandoLote(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && executarComandoLote()}
                            className="flex-1 px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs font-mono focus:outline-none focus:border-violet-500/40"
                          />
                          <button onClick={executarComandoLote} disabled={executandoLote || !comandoLote.trim()} className="px-4 py-1.5 rounded-lg bg-violet-500/10 hover:bg-violet-500/20 border border-violet-500/30 text-xs font-bold text-violet-300 cursor-pointer disabled:opacity-50 shrink-0 flex items-center gap-1.5">
                            {executandoLote ? <span className="w-3.5 h-3.5 border border-violet-500/30 border-t-violet-400 rounded-full animate-spin" /> : (
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                            )}
                            Executar em lote
                          </button>
                        </div>
                        <p className="text-[10px] text-zinc-600">Executa em paralelo nas {selecionadas.size} máquinas selecionadas (requer MFA ativo). Timeout 90s/máquina.</p>
                        {/* Resultados inline */}
                        {resultadosLote && (
                          <div className="mt-2 space-y-1 max-h-48 overflow-y-auto">
                            {resultadosLote.map((r) => (
                              <div key={r.maquinaId} className={`rounded-lg p-2 border text-xs flex items-start gap-2 ${r.ok ? "bg-emerald-500/5 border-emerald-500/20" : "bg-red-500/5 border-red-500/20"}`}>
                                <span className={`shrink-0 font-bold ${r.ok ? "text-emerald-400" : "text-red-400"}`}>{r.ok ? "✓" : "✕"}</span>
                                <div className="min-w-0">
                                  <span className={`font-semibold ${r.ok ? "text-emerald-300" : "text-red-300"}`}>{r.hostname}</span>
                                  <pre className="text-zinc-400 text-[10px] font-mono mt-0.5 whitespace-pre-wrap break-all line-clamp-3">{r.saida.slice(0, 300)}{r.saida.length > 300 ? "…" : ""}</pre>
                                </div>
                              </div>
                            ))}
                            <button onClick={() => setResultadosLote(null)} className="text-[10px] text-zinc-600 hover:text-zinc-400 cursor-pointer">Limpar resultados</button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-zinc-800/80 bg-zinc-950/20 text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                      <th className="px-4 py-4 w-10">
                        <input
                          type="checkbox"
                          title="Selecionar todas"
                          checked={maquinasFiltradas.length > 0 && maquinasFiltradas.every((m) => selecionadas.has(m.id))}
                          onChange={(e) =>
                            setSelecionadas(e.target.checked ? new Set(maquinasFiltradas.map((m) => m.id)) : new Set())
                          }
                          className="w-4 h-4 accent-emerald-500 cursor-pointer"
                        />
                      </th>
                      <th className="px-4 py-3 relative" style={{ width: colW.status }}>Saúde<span onMouseDown={(e) => iniciarResize(e, "status")} className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-emerald-500/40 select-none"></span></th>
                      <th className="px-4 py-3 hidden sm:table-cell">Score</th>
                      <th className="px-4 py-3 relative" style={{ width: colW.hostname }}>Hostname<span onMouseDown={(e) => iniciarResize(e, "hostname")} className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-emerald-500/40 select-none"></span></th>
                      <th className="px-4 py-3 hidden md:table-cell relative" style={{ width: colW.tipo }}>Tipo<span onMouseDown={(e) => iniciarResize(e, "tipo")} className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-emerald-500/40 select-none"></span></th>
                      <th className="px-4 py-3 hidden lg:table-cell relative" style={{ width: colW.grupo }}>Grupo<span onMouseDown={(e) => iniciarResize(e, "grupo")} className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-emerald-500/40 select-none"></span></th>
                      <th className="px-4 py-3 hidden xl:table-cell relative" style={{ width: colW.so }}>SO Versão<span onMouseDown={(e) => iniciarResize(e, "so")} className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-emerald-500/40 select-none"></span></th>
                      <th className="px-4 py-3 hidden xl:table-cell relative" style={{ width: colW.agente }}>Agente<span onMouseDown={(e) => iniciarResize(e, "agente")} className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-emerald-500/40 select-none"></span></th>
                      <th className="px-4 py-3 hidden 2xl:table-cell relative" style={{ width: colW.visto }}>Visto Em<span onMouseDown={(e) => iniciarResize(e, "visto")} className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-emerald-500/40 select-none"></span></th>
                      <th className="px-4 py-3 text-right">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/40 text-sm text-zinc-300">
                    {linhasAgrupadas.map((linha, li) => {
                      if (linha.tipo === "empresa") {
                        // Conta máquinas online e desatualizadas nesta empresa (e seus deps)
                        const desatualizadasEmp = versaoProd && linha.id
                          ? maquinasList.filter((m) => {
                              const deps = departamentosDe(linha.id!);
                              const gruposEmp = new Set([linha.id!, ...deps.map((d) => d.id)]);
                              return m.grupoId && gruposEmp.has(m.grupoId) && m.online && m.versaoAgente && m.versaoAgente !== versaoProd;
                            })
                          : [];
                        return (
                          <tr key={`emp-${li}`} className="bg-zinc-900/50">
                            <td colSpan={10} className="px-4 py-2.5 border-y border-zinc-800/80">
                              <div className="flex items-center gap-3">
                                <div className="flex items-center gap-2">
                                  <div className="w-5 h-5 rounded-md bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0">
                                    <svg className="w-3 h-3 text-violet-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M3 21h18M6 21V7l6-4 6 4v14"/><path d="M9 21v-4h6v4"/>
                                    </svg>
                                  </div>
                                  <span className="text-xs font-bold text-zinc-200 uppercase tracking-wider">{linha.nome}</span>
                                </div>
                                {desatualizadasEmp.length > 0 && (
                                  <button
                                    onClick={() => atualizarLote(linha.id)}
                                    disabled={atualizandoLoteGrupo === linha.id}
                                    title={`Atualizar ${desatualizadasEmp.length} agente(s) desatualizado(s) para v${versaoProd}`}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-[11px] font-semibold text-amber-300 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                                  >
                                    {atualizandoLoteGrupo === linha.id ? "…" : `↑ Atualizar ${desatualizadasEmp.length} desatualizada(s)`}
                                  </button>
                                )}
                                {updateMsg && updateMsg.id === linha.id && (
                                  <span className={`text-[11px] ${updateMsg.tipo === "ok" ? "text-emerald-400" : "text-red-400"}`}>{updateMsg.texto}</span>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      }
                      if (linha.tipo === "dept") {
                        return (
                          <tr key={`dep-${li}`} className="bg-zinc-950/30">
                            <td colSpan={10} className="px-4 py-1.5 pl-10 border-b border-zinc-800/40">
                              <div className="flex items-center gap-2">
                                <svg className="w-3 h-3 text-zinc-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M9 18l6-6-6-6"/>
                                </svg>
                                <span className="text-[11px] font-semibold text-zinc-400">{linha.nome}</span>
                              </div>
                            </td>
                          </tr>
                        );
                      }
                      const m = linha.m;
                      return (
                      <tr key={m.id} className={`hover:bg-zinc-900/10 transition-colors ${selecionadas.has(m.id) ? "bg-emerald-500/5" : ""}`}>
                        <td className="px-4 py-4">
                          <input
                            type="checkbox"
                            checked={selecionadas.has(m.id)}
                            onChange={() => toggleSelecao(m.id)}
                            className="w-4 h-4 accent-emerald-500 cursor-pointer"
                          />
                        </td>
                        <td className="px-4 py-2.5">
                          {(() => {
                            const sd = m.saude || (m.online ? "ok" : "offline");
                            const cfg = sd === "critico" ? { cl: "bg-red-500/10 text-red-400 border-red-500/30", dot: "bg-red-500 glow-red", t: "Crítico" }
                              : sd === "alerta" ? { cl: "bg-amber-500/10 text-amber-400 border-amber-500/30", dot: "bg-amber-500", t: "Alerta" }
                              : sd === "ok" ? { cl: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20", dot: "bg-emerald-500 glow-emerald animate-pulse-subtle", t: "Saudável" }
                              : { cl: "bg-zinc-900 text-zinc-500 border-zinc-800/80", dot: "bg-zinc-600", t: "Offline" };
                            const tip = m.online ? `CPU ${m.cpu ?? "?"}% · RAM ${m.ram ?? "?"}%` : "Máquina offline";
                            return (
                              <div className="space-y-1.5">
                                <span title={tip} className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border whitespace-nowrap ${cfg.cl}`}>
                                  <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`}></span>
                                  {cfg.t}
                                </span>
                                {m.online && m.vistoEm && (() => {
                                  const secsAgo = Math.floor((Date.now() - new Date(m.vistoEm).getTime()) / 1000);
                                  const label = secsAgo < 10 ? `<10s` : secsAgo < 60 ? `${secsAgo}s` : `${Math.floor(secsAgo / 60)}m`;
                                  const cor = secsAgo < 30 ? "text-emerald-500" : secsAgo < 90 ? "text-amber-400" : "text-red-400";
                                  return <span className={`text-[9px] font-mono ${cor}`} title={`Último heartbeat: ${secsAgo}s atrás`}>⟳ {label}</span>;
                                })()}
                                {m.online && (m.cpu != null || m.ram != null) && (
                                  <div className="flex flex-col gap-0.5 min-w-[72px]">
                                    {m.cpu != null && (
                                      <div className="flex items-center gap-1.5">
                                        <span className="text-[9px] text-zinc-500 w-7 shrink-0 font-mono">CPU</span>
                                        <div className="flex-1 h-1 rounded-full bg-zinc-800 overflow-hidden">
                                          <div className={`h-full rounded-full transition-all duration-700 ${m.cpu > 90 ? "bg-red-500" : m.cpu > 70 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${m.cpu}%` }} />
                                        </div>
                                        <span className={`text-[9px] font-mono shrink-0 ${m.cpu > 90 ? "text-red-400" : m.cpu > 70 ? "text-amber-400" : "text-emerald-500"}`}>{m.cpu}%</span>
                                      </div>
                                    )}
                                    {m.ram != null && (
                                      <div className="flex items-center gap-1.5">
                                        <span className="text-[9px] text-zinc-500 w-7 shrink-0 font-mono">RAM</span>
                                        <div className="flex-1 h-1 rounded-full bg-zinc-800 overflow-hidden">
                                          <div className={`h-full rounded-full transition-all duration-700 ${m.ram > 90 ? "bg-red-500" : m.ram > 70 ? "bg-amber-500" : "bg-sky-500"}`} style={{ width: `${m.ram}%` }} />
                                        </div>
                                        <span className={`text-[9px] font-mono shrink-0 ${m.ram > 90 ? "text-red-400" : m.ram > 70 ? "text-amber-400" : "text-sky-400"}`}>{m.ram}%</span>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </td>
                        <td className="px-3 py-2 hidden sm:table-cell">
                          <HealthBadge score={m.healthScore ?? null} tendencia={m.tendenciaScore} />
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <div className="min-w-0">
                              <div className="font-semibold text-white truncate">{m.apelido || m.hostname}</div>
                              {m.apelido && (
                                <div className="text-[11px] text-zinc-500 font-mono truncate">{m.hostname}</div>
                              )}
                              {m.tags && m.tags.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {m.tags.map((t: string) => (
                                    <button key={t} onClick={() => setFiltroTag(filtroTag === t ? null : t)} className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] border cursor-pointer transition-colors duration-150 ${filtroTag === t ? "bg-emerald-500/20 text-emerald-200 border-emerald-500/40" : "bg-zinc-800/60 text-zinc-400 border-zinc-700 hover:text-emerald-300"}`}>
                                      <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.5" fill="currentColor" stroke="none"/></svg>
                                      {t}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                            <button
                              onClick={() => renomearMaquina(m)}
                              title="Renomear (nome amigável)"
                              className="text-zinc-600 hover:text-emerald-300 transition-colors duration-150 cursor-pointer"
                            >
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                              </svg>
                            </button>
                            <button
                              onClick={() => {
                                const txt = m.apelido || m.hostname || "";
                                navigator.clipboard.writeText(txt).then(() => mostrarToast(`Copiado: ${txt}`, "ok")).catch(() => mostrarToast("Falha ao copiar", "erro"));
                              }}
                              title="Copiar nome/hostname"
                              className="text-zinc-700 hover:text-sky-400 transition-colors duration-150 cursor-pointer"
                            >
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                                <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                              </svg>
                            </button>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap hidden md:table-cell">
                          <button
                            onClick={() =>
                              atribuirMaquina(m.id, {
                                tipoMaquina: m.tipoMaquina === "pc" ? "notebook" : m.tipoMaquina === "notebook" ? "servidor" : m.tipoMaquina === "servidor" ? "mobile" : m.tipoMaquina === "mobile" ? "tablet" : "pc",
                              })
                            }
                            title="Clique para alternar PC › Notebook › Servidor › Mobile › Tablet"
                            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold border cursor-pointer ${
                              m.tipoMaquina === "servidor"
                                ? "bg-sky-500/10 text-sky-300 border-sky-500/20"
                                : m.tipoMaquina === "notebook"
                                ? "bg-violet-500/10 text-violet-300 border-violet-500/20"
                                : m.tipoMaquina === "mobile" || m.tipoMaquina === "tablet"
                                ? "bg-amber-500/10 text-amber-300 border-amber-500/20"
                                : "bg-zinc-800/60 text-zinc-300 border-zinc-700"
                            }`}
                          >
                            {m.tipoMaquina === "servidor" ? (
                              <><svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg> Servidor</>
                            ) : m.tipoMaquina === "notebook" ? (
                              <><svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/></svg> Notebook</>
                            ) : m.tipoMaquina === "mobile" ? (
                              <><svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="18" r="0.5" fill="currentColor"/></svg> Mobile</>
                            ) : m.tipoMaquina === "tablet" ? (
                              <><svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><circle cx="12" cy="18" r="0.5" fill="currentColor"/></svg> Tablet</>
                            ) : (
                              <><svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg> PC</>
                            )}
                          </button>
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap hidden lg:table-cell">
                          <select
                            value={m.grupoId ?? ""}
                            onChange={(e) =>
                              atribuirMaquina(m.id, { grupoId: e.target.value === "" ? null : e.target.value })
                            }
                            className="bg-zinc-950 border border-zinc-800 rounded-md text-xs text-zinc-300 px-2 py-1.5 focus:outline-none focus:border-emerald-500/40 cursor-pointer max-w-[160px]"
                          >
                            <option value="">Sem grupo</option>
                            {empresas.map((emp) => (
                              <optgroup key={emp.id} label={emp.nome}>
                                <option value={emp.id}>{emp.nome} (empresa)</option>
                                {departamentosDe(emp.id).map((dep) => (
                                  <option key={dep.id} value={dep.id}>
                                    &nbsp;&nbsp;↳ {dep.nome}
                                  </option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-zinc-400 text-xs hidden xl:table-cell">{m.soVersao || "Desconhecido"}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap hidden xl:table-cell">
                          {m.versaoAgente ? (() => {
                            const desatualizado = versaoProd && m.versaoAgente !== versaoProd;
                            return (
                              <span
                                title={desatualizado ? `Versão instalada: v${m.versaoAgente} · Nova versão disponível: v${versaoProd}` : `Versão atual: v${m.versaoAgente}`}
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border font-mono text-[11px] ${desatualizado ? "bg-amber-500/10 border-amber-500/30 text-amber-400" : "bg-zinc-900 border-zinc-700 text-zinc-400"}`}
                              >
                                {desatualizado && <span className="text-[10px]">⚠</span>}
                                v{m.versaoAgente}
                              </span>
                            );
                          })() : (
                            <span className="text-zinc-600 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-xs text-zinc-400 hidden 2xl:table-cell">
                          {m.vistoEm ? new Date(m.vistoEm).toLocaleString() : "Nunca"}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-right">
                          {/* WoL — só aparece quando offline e MAC disponível */}
                          {!m.online && m.macAddress && (
                            <button
                              onClick={() => enviarWol(m)}
                              disabled={enviandoWol === m.id}
                              title={`Wake-on-LAN — ligar ${m.apelido || m.hostname} (MAC: ${m.macAddress})`}
                              className="w-8 h-8 inline-flex items-center justify-center rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 transition-colors duration-150 cursor-pointer mr-1 disabled:opacity-30 disabled:cursor-not-allowed align-middle"
                            >
                              {enviandoWol === m.id ? <span className="w-3 h-3 border border-amber-500/30 border-t-amber-400 rounded-full animate-spin" /> : (
                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                                </svg>
                              )}
                            </button>
                          )}
                          <button
                            onClick={() => abrirTela(m)}
                            disabled={abrindoTela === m.id || !m.online || !/windows|mac os|macos|darwin|android/i.test(m.soVersao || "") && m.tipoMaquina !== "mobile" && m.tipoMaquina !== "tablet"}
                            title={
                              (!/windows|mac os|macos|darwin|android/i.test(m.soVersao || "") && m.tipoMaquina !== "mobile" && m.tipoMaquina !== "tablet")
                                ? "Tela remota disponível em Windows, macOS e Android (Linux: em breve)"
                                : m.online
                                ? "Acesso remoto (tela ao vivo)"
                                : "Disponível só com a máquina online"
                            }
                            className="w-8 h-8 inline-flex items-center justify-center rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 transition-colors duration-150 cursor-pointer mr-2 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-emerald-500/10 align-middle"
                          >
                            {abrindoTela === m.id ? <span className="w-3 h-3 border border-emerald-500/30 border-t-emerald-400 rounded-full animate-spin" /> : (m.tipoMaquina === "mobile" || m.tipoMaquina === "tablet") ? (
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                                <rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="18" r="1" fill="currentColor"/>
                              </svg>
                            ) : (
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                                <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
                              </svg>
                            )}
                          </button>
                          {/* Botão de atualização — visível só quando há versão nova e máquina online */}
                          {m.online && versaoProd && m.versaoAgente && m.versaoAgente !== versaoProd && (
                            <button
                              onClick={() => atualizarAgente(m.id)}
                              disabled={atualizandoMaquinaId === m.id}
                              title={`Atualizar agente de v${m.versaoAgente} → v${versaoProd}`}
                              className="w-8 h-8 inline-flex items-center justify-center rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-sm text-amber-300 transition-colors cursor-pointer mr-1 disabled:opacity-40 disabled:cursor-not-allowed align-middle"
                            >
                              {atualizandoMaquinaId === m.id ? "…" : "↑"}
                            </button>
                          )}
                          <button
                            onClick={() => gerenciarServicos(m)}
                            className="px-3.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs font-semibold text-zinc-300 transition-colors cursor-pointer"
                          >
                            Gerenciar
                          </button>
                          <button
                            onClick={() => removerMaquina(m)}
                            title="Remover (arquivar) esta máquina"
                            className="ml-2 w-7 h-7 inline-flex items-center justify-center rounded-lg bg-zinc-900 hover:bg-red-500/20 hover:text-red-400 border border-zinc-800 hover:border-red-500/30 text-xs font-bold text-zinc-500 transition-colors cursor-pointer align-middle"
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            </div>
          </div>
        </section>
      </main>
      )}
      </div>

      {/* Modal de texto (substitui o prompt nativo do navegador) */}
      {promptCfg && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-sm glass-panel-neon rounded-2xl p-5 border border-zinc-800">
            <h3 className="text-sm font-bold text-white mb-3">{promptCfg.titulo}</h3>
            <input
              autoFocus
              value={promptCfg.valor}
              onChange={(e) => setPromptCfg({ ...promptCfg, valor: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") { promptCfg.resolve(promptCfg.valor); setPromptCfg(null); }
                if (e.key === "Escape") { promptCfg.resolve(null); setPromptCfg(null); }
              }}
              className="w-full px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm focus:outline-none focus:border-emerald-500/40"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => { promptCfg.resolve(null); setPromptCfg(null); }} className="px-4 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-400 cursor-pointer">Cancelar</button>
              <button onClick={() => { promptCfg.resolve(promptCfg.valor); setPromptCfg(null); }} className="px-4 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs font-semibold text-emerald-300 cursor-pointer">OK</button>
            </div>
          </div>
        </div>
      )}

      {/* Toast stack — sistema centralizado */}
      {toasts.length > 0 && (
        <div className="fixed bottom-5 right-5 z-[90] flex flex-col gap-2 pointer-events-none" style={{ maxWidth: "360px" }}>
          {toasts.map((t) => {
            const cfg = t.tipo === "ok"
              ? { bg: "bg-emerald-950/95 border-emerald-500/30 text-emerald-300", icon: <polyline points="20 6 9 17 4 12"/> }
              : t.tipo === "erro"
              ? { bg: "bg-red-950/95 border-red-500/30 text-red-300", icon: <><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></> }
              : t.tipo === "aviso"
              ? { bg: "bg-amber-950/95 border-amber-500/30 text-amber-300", icon: <><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></> }
              : { bg: "bg-zinc-900/95 border-zinc-700/50 text-zinc-300", icon: <><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></> };
            return (
              <div key={t.id} className={`rounded-xl border shadow-xl px-4 py-3 flex items-center gap-2.5 text-sm font-medium animate-in slide-in-from-right-4 fade-in duration-200 backdrop-blur-sm ${cfg.bg}`}>
                <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                  {cfg.icon}
                </svg>
                <span className="flex-1 leading-snug">{t.msg}</span>
                <button onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))} className="pointer-events-auto text-current/40 hover:text-current/80 shrink-0 cursor-pointer">
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Command Palette (Ctrl+K) */}
      {paletteAberta && (() => {
        const q = paletteQuery.trim().toLowerCase();
        const maqResultados = maquinasList
          .filter((m) =>
            !q ||
            m.hostname?.toLowerCase().includes(q) ||
            m.apelido?.toLowerCase().includes(q) ||
            m.responsavel?.toLowerCase().includes(q) ||
            m.tags?.some((t) => t.toLowerCase().includes(q))
          )
          .slice(0, 8);
        const navItems = [
          { label: "Dashboard", desc: "Visão geral e briefing IA", secaoAlvo: "dashboard", icon: <><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></> },
          { label: "Máquinas", desc: "Lista de endpoints monitorados", secaoAlvo: "maquinas", icon: <><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></> },
          { label: "Empresas", desc: "Grupos e empresas cadastradas", secaoAlvo: "empresas", icon: <><path d="M3 21h18M6 21V7l6-4 6 4v14"/><path d="M9 21v-4h6v4"/></> },
          { label: "Relatórios", desc: "Relatórios e inventário", secaoAlvo: "relatorios", icon: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></> },
          { label: "Segurança", desc: "Alertas e auditoria de segurança", secaoAlvo: "seguranca", icon: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></> },
          { label: "Planos", desc: "Planos e configurações do tenant", secaoAlvo: "planos", icon: <><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93l-1.41 1.41M5.34 17.66l-1.41 1.41M16.24 16.24l1.41 1.41M6.17 6.17L4.76 7.59M21 12h-2M5 12H3M12 21v-2M12 5V3"/></> },
        ].filter((n) => !q || n.label.toLowerCase().includes(q) || n.desc.toLowerCase().includes(q));
        const totalItems = maqResultados.length + navItems.length;
        const safeIdx = totalItems === 0 ? 0 : ((paletteIdx % totalItems) + totalItems) % totalItems;
        return (
          <div
            className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] px-4"
            onClick={() => setPaletteAberta(false)}
          >
            <div
              className="w-full max-w-xl rounded-2xl bg-zinc-950/98 border border-zinc-800 shadow-2xl overflow-hidden backdrop-blur-xl"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Input */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800">
                <svg className="w-4 h-4 text-zinc-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
                </svg>
                <input
                  ref={paletteInputRef}
                  type="text"
                  value={paletteQuery}
                  onChange={(e) => { setPaletteQuery(e.target.value); setPaletteIdx(0); }}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") { e.preventDefault(); setPaletteIdx((i) => (i + 1) % Math.max(1, totalItems)); }
                    else if (e.key === "ArrowUp") { e.preventDefault(); setPaletteIdx((i) => ((i - 1) + Math.max(1, totalItems)) % Math.max(1, totalItems)); }
                    else if (e.key === "Enter") {
                      e.preventDefault();
                      if (safeIdx < navItems.length) {
                        setSecao(navItems[safeIdx].secaoAlvo as any);
                        setPaletteAberta(false);
                      } else {
                        const m = maqResultados[safeIdx - navItems.length];
                        if (m) { setMaquinaServicos(m); setSecao("maquinas"); setPaletteAberta(false); }
                      }
                    } else if (e.key === "Escape") {
                      setPaletteAberta(false);
                    }
                  }}
                  placeholder="Buscar máquinas ou navegar..."
                  className="flex-1 bg-transparent text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
                />
                <kbd className="text-[10px] text-zinc-600 border border-zinc-800 rounded px-1.5 py-0.5 font-mono shrink-0">ESC</kbd>
              </div>
              {/* Resultados */}
              <div className="max-h-[360px] overflow-y-auto p-1.5">
                {/* Navegação */}
                {navItems.length > 0 && (
                  <div>
                    <p className="px-2 py-1 text-[10px] font-semibold text-zinc-600 uppercase tracking-wider">Navegação</p>
                    {navItems.map((n, i) => (
                      <button
                        key={n.secaoAlvo}
                        onClick={() => { setSecao(n.secaoAlvo as any); setPaletteAberta(false); }}
                        className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors duration-100 cursor-pointer ${safeIdx === i ? "bg-zinc-800" : "hover:bg-zinc-900"}`}
                      >
                        <svg className="w-4 h-4 text-zinc-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">{n.icon}</svg>
                        <div className="min-w-0">
                          <span className="text-sm text-zinc-200 font-medium">{n.label}</span>
                          <span className="ml-2 text-xs text-zinc-600">{n.desc}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                {/* Máquinas */}
                {maqResultados.length > 0 && (
                  <div className={navItems.length > 0 ? "mt-1" : ""}>
                    <p className="px-2 py-1 text-[10px] font-semibold text-zinc-600 uppercase tracking-wider">Máquinas</p>
                    {maqResultados.map((m, i) => {
                      const globalIdx = navItems.length + i;
                      return (
                        <button
                          key={m.id}
                          onClick={() => { setMaquinaServicos(m); setSecao("maquinas"); setPaletteAberta(false); }}
                          className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors duration-100 cursor-pointer ${safeIdx === globalIdx ? "bg-zinc-800" : "hover:bg-zinc-900"}`}
                        >
                          <div className={`w-2 h-2 rounded-full shrink-0 ${m.online ? "bg-emerald-500" : "bg-zinc-700"}`} />
                          <div className="min-w-0 flex-1">
                            <span className="text-sm text-zinc-200 font-medium truncate block">{m.apelido || m.hostname}</span>
                            <span className="text-xs text-zinc-600 truncate block">{m.ipPublico || m.macAddress || ""}{m.soVersao ? ` · ${m.soVersao}` : ""}</span>
                          </div>
                          {m.online && m.cpu != null && (
                            <span className="text-[10px] font-mono text-zinc-600 shrink-0">CPU {m.cpu}%</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
                {totalItems === 0 && (
                  <div className="px-4 py-8 text-center text-sm text-zinc-600">
                    Nenhum resultado para &ldquo;{paletteQuery}&rdquo;
                  </div>
                )}
              </div>
              {/* Footer */}
              <div className="border-t border-zinc-800/60 px-4 py-2 flex items-center gap-4 text-[10px] text-zinc-700">
                <span><kbd className="border border-zinc-800 rounded px-1 font-mono">↑↓</kbd> navegar</span>
                <span><kbd className="border border-zinc-800 rounded px-1 font-mono">Enter</kbd> selecionar</span>
                <span><kbd className="border border-zinc-800 rounded px-1 font-mono">Ctrl+K</kbd> fechar</span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Toast de feedback de atualização de agente */}
      {updateMsg && (
        <div className="fixed bottom-20 right-5 z-[70] w-full max-w-sm animate-fade-in-up pointer-events-none">
          <div className={`rounded-xl border shadow-xl px-4 py-3 flex items-center gap-2 text-sm font-medium ${updateMsg.tipo === "ok" ? "bg-emerald-950/90 border-emerald-500/30 text-emerald-300" : "bg-red-950/90 border-red-500/30 text-red-300"}`}>
            <span className="shrink-0">{updateMsg.tipo === "ok" ? "✓" : "✕"}</span>
            <span>{updateMsg.texto}</span>
          </div>
        </div>
      )}

      {/* Toast de resumo automático de sessão terminal */}
      {resumoSessao && resumoSessao.visivel && (
        <div className="fixed bottom-5 right-5 z-[70] w-full max-w-sm animate-fade-in-up">
          <div className="glass-panel rounded-2xl border border-zinc-700/80 shadow-2xl overflow-hidden">
            {/* Barra superior colorida */}
            <div className="h-0.5 w-full bg-gradient-to-r from-violet-500 via-emerald-500 to-violet-500" />
            <div className="p-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-lg bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0">
                    <svg className="w-3.5 h-3.5 text-violet-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
                    </svg>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-white">Sessão resumida</p>
                    <p className="text-[10px] text-zinc-500">
                      {resumoSessao.semIA ? "análise local" : "IA · Claude Haiku"}
                      {resumoSessao.manutencaoId && " · salvo no histórico"}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setResumoSessao(null)}
                  className="w-6 h-6 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-500 hover:text-zinc-300 cursor-pointer shrink-0 transition-colors"
                >
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
              </div>

              {/* Categoria badge */}
              <div className="flex items-center gap-2 mb-2.5">
                {(() => {
                  const catMap: Record<string, { label: string; cls: string }> = {
                    manutencao:    { label: "Manutenção",    cls: "bg-red-500/10 border-red-500/20 text-red-400" },
                    diagnostico:   { label: "Diagnóstico",   cls: "bg-amber-500/10 border-amber-500/20 text-amber-400" },
                    configuracao:  { label: "Configuração",  cls: "bg-cyan-500/10 border-cyan-500/20 text-cyan-400" },
                    investigacao:  { label: "Investigação",  cls: "bg-violet-500/10 border-violet-500/20 text-violet-400" },
                    rotina:        { label: "Rotina",        cls: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" },
                  };
                  const c = catMap[resumoSessao.categoria] ?? catMap.rotina;
                  return (
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${c!.cls}`}>
                      {c!.label}
                    </span>
                  );
                })()}
                {resumoSessao.manutencaoId && (
                  <span className="flex items-center gap-1 text-[10px] text-emerald-400">
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                    Salvo no histórico
                  </span>
                )}
              </div>

              {/* Resumo */}
              <p className="text-xs text-zinc-300 leading-relaxed line-clamp-3">{resumoSessao.resumo}</p>

              {/* Ação: ver manutenção */}
              {resumoSessao.manutencaoId && maquinaServicos && (
                <button
                  onClick={() => {
                    setAbaAtiva("manutencao");
                    setResumoSessao(null);
                  }}
                  className="mt-3 w-full text-center text-[11px] text-violet-400 hover:text-violet-300 transition-colors cursor-pointer"
                >
                  Ver no histórico de manutenção →
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal de Diagnóstico IA */}
      {diagnosticoModal && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setDiagnosticoModal(null); }}
        >
          <div className="w-full max-w-lg glass-panel rounded-2xl border border-zinc-800 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800/60">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center">
                  <svg className="w-4 h-4 text-violet-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4m0 0h18" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-bold text-white">Diagnóstico IA</p>
                  <p className="text-[10px] text-zinc-500 font-mono">
                    {maquinaServicos ? (maquinaServicos.apelido || maquinaServicos.hostname) : "Máquina"}
                  </p>
                </div>
              </div>
              <button onClick={() => setDiagnosticoModal(null)} className="w-7 h-7 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-500 hover:text-zinc-300 cursor-pointer transition-colors">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>

            {/* Body */}
            <div className="p-5">
              {diagnosticoModal.estado === "carregando" && (
                <div className="flex flex-col items-center gap-4 py-8">
                  <div className="w-10 h-10 rounded-full border-2 border-violet-500/30 border-t-violet-400 animate-spin" />
                  <p className="text-sm text-zinc-400">Analisando métricas, alertas e comportamento recente…</p>
                </div>
              )}

              {diagnosticoModal.estado === "erro" && (
                <div className="flex flex-col items-center gap-3 py-6">
                  <div className="w-10 h-10 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center">
                    <svg className="w-5 h-5 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>
                  </div>
                  <p className="text-sm text-red-400">Erro ao gerar diagnóstico</p>
                  <p className="text-xs text-zinc-500">{diagnosticoModal.erro}</p>
                  <button onClick={() => executarDiagnostico(diagnosticoModal.maquinaId)} className="mt-2 px-4 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-300 cursor-pointer hover:border-zinc-700">Tentar novamente</button>
                </div>
              )}

              {diagnosticoModal.estado === "resultado" && diagnosticoModal.resultado && (() => {
                const d = diagnosticoModal.resultado;
                const sevCor: Record<string, { bg: string; border: string; text: string; label: string }> = {
                  critica: { bg: "bg-red-500/10", border: "border-red-500/30", text: "text-red-400", label: "CRÍTICA" },
                  alta:    { bg: "bg-orange-500/10", border: "border-orange-500/30", text: "text-orange-400", label: "ALTA" },
                  media:   { bg: "bg-amber-500/10", border: "border-amber-500/30", text: "text-amber-400", label: "MÉDIA" },
                  baixa:   { bg: "bg-emerald-500/10", border: "border-emerald-500/30", text: "text-emerald-400", label: "BAIXA" },
                };
                const cor = sevCor[d.severidade] ?? sevCor.media;
                return (
                  <div className="space-y-4">
                    {/* Severity badge */}
                    <div className="flex items-center gap-3">
                      <span className={`px-3 py-1 rounded-full text-xs font-bold border ${cor.bg} ${cor.border} ${cor.text}`}>
                        ● SEVERIDADE {cor.label}
                      </span>
                      {d.semIA && (
                        <span className="text-[10px] text-zinc-600 font-mono">análise local (sem IA)</span>
                      )}
                      {d.cached && (
                        <span className="text-[10px] text-zinc-600 font-mono">cache</span>
                      )}
                    </div>

                    {/* Causa */}
                    <div className="glass-panel rounded-xl p-4 border border-zinc-800">
                      <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-2">Causa identificada</p>
                      <p className="text-sm text-zinc-200 leading-relaxed">{d.causa}</p>
                    </div>

                    {/* Ações recomendadas */}
                    <div>
                      <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-2">Ações recomendadas</p>
                      <div className="space-y-2">
                        {d.acoes.map((acao, i) => (
                          <div key={i} className="flex items-start gap-3 glass-panel rounded-xl px-4 py-3 border border-zinc-800">
                            <span className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold mt-0.5 ${cor.bg} ${cor.text} border ${cor.border}`}>{i + 1}</span>
                            <p className="text-xs text-zinc-300 leading-relaxed">{acao}</p>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Footer */}
                    <div className="flex items-center justify-between pt-1">
                      <p className="text-[10px] text-zinc-600 font-mono">
                        Gerado em {new Date(d.geradoEm).toLocaleString("pt-BR")}
                      </p>
                      <button
                        onClick={() => executarDiagnostico(diagnosticoModal.maquinaId, true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-400 hover:text-zinc-200 hover:border-zinc-700 cursor-pointer transition-all"
                      >
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                        Reanalisar
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Acesso remoto embutido (iframe, sem nova aba) */}
      {telaUrl && (
        <div className="fixed inset-0 z-50 bg-black flex flex-col">
          <div className="flex items-center px-3 py-1.5 bg-zinc-950 border-b border-zinc-800 shrink-0 gap-2 flex-wrap">
            {/* Máquina + status */}
            <span className="text-xs font-semibold text-white flex items-center gap-1.5 min-w-0 shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0"></span>
              {telaNome}
            </span>

            {/* Seletor de monitor — aparece só quando há 2+ monitores */}
            {monitoresMaquina.length > 1 && (
              <div className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto">
                <span className="text-[10px] text-zinc-500 shrink-0 mr-0.5">Monitor:</span>
                {monitoresMaquina.map((mon, i) => (
                  <button
                    key={i}
                    onClick={() => selecionarMonitor(i)}
                    title={`Tela ${i + 1} — ${mon.w}×${mon.h}`}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border transition-colors cursor-pointer shrink-0 ${
                      monitorIdx === i
                        ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                        : "bg-zinc-900 text-zinc-400 border-zinc-700 hover:border-emerald-500/30 hover:text-emerald-300"
                    }`}
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
                    </svg>
                    {i + 1}
                    {mon.w > 0 && <span className="text-[9px] opacity-60 font-mono">{mon.w}×{mon.h}</span>}
                  </button>
                ))}
              </div>
            )}

            {/* Ações */}
            <div className="flex items-center gap-1.5 ml-auto shrink-0">
              <button
                onClick={() => {
                  const w = window.open(telaUrl, "_blank", "width=1280,height=800,menubar=no,toolbar=no,status=no,scrollbars=no");
                  if (w) setTelaUrl(null);
                }}
                className="text-xs text-zinc-400 hover:text-emerald-300 px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-emerald-500/30 cursor-pointer transition-colors"
                title="Abrir em janela separada"
              >
                ⧉ Janela
              </button>
              <a
                href={telaUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-zinc-400 hover:text-white px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 cursor-pointer transition-colors"
                title="Abrir em nova aba"
              >
                ↗ Aba
              </a>
              <button
                onClick={() => setTelaUrl(null)}
                className="text-xs font-bold text-zinc-400 hover:text-red-400 px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-red-500/30 cursor-pointer transition-colors"
                title="Fechar acesso remoto"
              >
                ✕
              </button>
            </div>
          </div>
          <iframe src={telaUrl} className="flex-1 w-full border-0 bg-black" title="Acesso remoto" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
        </div>
      )}

      {/* Agendador de tarefas */}
      {vistaTarefas && (
        <div className="fixed inset-0 z-40 bg-zinc-950 flex flex-col animate-in fade-in duration-150">
          <div className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between bg-zinc-950/60 backdrop-blur">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">⏰ Agendador de tarefas <span className="text-xs text-zinc-500 font-normal">({tarefasList.length})</span></h2>
            <button onClick={() => setVistaTarefas(false)} className="px-4 py-2 rounded-xl bg-zinc-900 border border-zinc-800 hover:text-red-400 hover:border-red-500/30 text-zinc-400 text-xs font-semibold cursor-pointer">Fechar ✕</button>
          </div>
          <div className="flex-1 overflow-y-auto p-6">
            <div className="max-w-4xl mx-auto w-full space-y-5">
              <div className="glass-panel rounded-2xl p-4 border border-zinc-800 space-y-3">
                <h3 className="text-sm font-bold text-white">Nova tarefa agendada</h3>
                <div className="flex flex-wrap gap-2">
                  <select value={tarefaMaquina} onChange={(e) => setTarefaMaquina(e.target.value)} className="px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs cursor-pointer min-w-[160px]">
                    <option value="">Máquina...</option>
                    {maquinasList.map((m) => <option key={m.id} value={m.id}>{m.apelido || m.hostname}</option>)}
                  </select>
                  <input value={tarefaNome} onChange={(e) => setTarefaNome(e.target.value)} placeholder="Nome (ex.: Limpar temp)" className="px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm flex-1 min-w-[160px] focus:outline-none focus:border-emerald-500/40" />
                  <select value={tarefaFreq} onChange={(e) => setTarefaFreq(e.target.value)} className="px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs cursor-pointer">
                    <option value="diaria">Todo dia</option>
                    <option value="unica">Uma vez</option>
                  </select>
                  {tarefaFreq === "diaria" ? (
                    <input type="time" value={tarefaHorario} onChange={(e) => setTarefaHorario(e.target.value)} className="px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs cursor-pointer" />
                  ) : (
                    <input type="datetime-local" value={tarefaDataUnica} onChange={(e) => setTarefaDataUnica(e.target.value)} className="px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs cursor-pointer" />
                  )}
                </div>
                <textarea value={tarefaComando} onChange={(e) => setTarefaComando(e.target.value)} placeholder="Comando PowerShell (ex.: Remove-Item $env:TEMP\* -Recurse -Force -EA SilentlyContinue)" rows={2} className="w-full px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs font-mono focus:outline-none focus:border-emerald-500/40 resize-none" />
                <button onClick={criarTarefa} className="px-5 py-2 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-sm font-semibold text-emerald-300 cursor-pointer">Agendar (exige MFA)</button>
                <p className="text-[10px] text-zinc-500">O servidor dispara o comando na máquina no horário. A máquina precisa estar online na hora.</p>
              </div>
              <div className="space-y-2">
                {tarefasList.length === 0 ? (
                  <div className="text-center py-10 text-xs text-zinc-500">Nenhuma tarefa agendada.</div>
                ) : tarefasList.map((t) => (
                  <div key={t.id} className="flex items-center justify-between gap-3 p-3 rounded-xl bg-zinc-900/40 border border-zinc-800">
                    <div className="min-w-0">
                      <div className="text-sm text-white truncate">{t.nome} <span className="text-[10px] text-zinc-500">· {t.maquinaNome}</span></div>
                      <div className="text-[10px] text-zinc-500 font-mono truncate" title={t.comando}>{t.comando}</div>
                      <div className="text-[10px] text-zinc-500 mt-0.5">
                        {t.frequencia === "diaria" ? `Todo dia ${t.horario}` : "Uma vez"}
                        {t.proximaExec && t.ativo && <span> · próxima: {new Date(t.proximaExec).toLocaleString()}</span>}
                        {t.ultimoStatus && <span className={`inline-flex items-center gap-0.5 ${t.ultimoStatus === "SUCESSO" ? "text-emerald-400" : "text-red-400"}`}> · último: {t.ultimoStatus === "SUCESSO" ? <svg className="w-3 h-3 inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> : <svg className="w-3 h-3 inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>} {t.ultimoStatus}</span>}
                      </div>
                    </div>
                    <div className="flex gap-2 items-center shrink-0">
                      <button onClick={() => toggleTarefa(t.id, !t.ativo)} className={`px-2.5 py-1.5 rounded-lg border text-[10px] font-semibold cursor-pointer ${t.ativo ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30" : "bg-zinc-800 text-zinc-500 border-zinc-700"}`}>{t.ativo ? "Ativa" : "Pausada"}</button>
                      <button onClick={() => excluirTarefa(t.id)} className="px-2.5 py-1.5 rounded-lg bg-red-500/10 text-red-300 border border-red-500/30 text-[10px] font-semibold cursor-pointer">Excluir</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Central de Chamados / Helpdesk */}
      {vistaChamados && (
        <div className="fixed inset-0 z-40 bg-zinc-950 flex flex-col animate-in fade-in duration-150">
          <div className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between bg-zinc-950/60 backdrop-blur">
            <h2 className="text-lg font-bold text-white flex items-center gap-2.5">
              <svg className="w-5 h-5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
              </svg>
              Chamados
              <span className="px-2 py-0.5 rounded-full bg-zinc-800 border border-zinc-700 text-xs text-zinc-400 font-normal">{chamadosList.length}</span>
            </h2>
            <div className="flex gap-2">
              <button onClick={() => { setModoNovoChamado(true); setChamadoSel(null); }} className="px-4 py-2 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-xs font-semibold text-emerald-300 cursor-pointer">+ Novo Chamado</button>
              <button onClick={() => setVistaChamados(false)} className="px-4 py-2 rounded-xl bg-zinc-900 border border-zinc-800 hover:text-red-400 hover:border-red-500/30 text-zinc-400 text-xs font-semibold cursor-pointer">Fechar ✕</button>
            </div>
          </div>
          <div className="flex-1 flex min-h-0">
            <div className="w-80 shrink-0 border-r border-zinc-800 overflow-y-auto">
              {chamadosList.length === 0 ? (
                <div className="px-4 py-12 text-center text-xs text-zinc-500">Nenhum chamado ainda.<br/>Clique em &quot;Novo Chamado&quot;.</div>
              ) : (
                chamadosList.map((c) => (
                  <button key={c.id} onClick={() => abrirDetalheChamado(c.id)} className={`w-full text-left px-4 py-3 border-b border-zinc-900/60 hover:bg-zinc-900/40 transition-colors cursor-pointer ${chamadoSel?.chamado?.id === c.id ? "bg-emerald-500/5 border-l-2 border-l-emerald-500" : ""}`}>
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs font-semibold text-white truncate flex-1">{c.titulo}</span>
                      <span className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold border ${c.status === "resolvido" ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30" : c.status === "fechado" ? "bg-zinc-800 text-zinc-500 border-zinc-700" : c.status === "em_andamento" ? "bg-amber-500/10 text-amber-300 border-amber-500/30" : "bg-blue-500/10 text-blue-300 border-blue-500/30"}`}>{c.status === "em_andamento" ? "em andamento" : c.status}</span>
                    </div>
                    <div className="text-[10px] text-zinc-500 mt-1 truncate flex items-center gap-1">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.prioridade === "critica" ? "bg-red-500" : c.prioridade === "alta" ? "bg-orange-400" : c.prioridade === "media" ? "bg-sky-400" : "bg-zinc-500"}`}></span>
                      {c.prioridade}{c.maquinaNome ? ` · ${c.maquinaNome}` : ""}
                    </div>
                  </button>
                ))
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {modoNovoChamado ? (
                <div className="max-w-2xl space-y-3">
                  <h3 className="text-sm font-bold text-white">Novo Chamado</h3>
                  <input value={novoTitulo} onChange={(e) => setNovoTitulo(e.target.value)} placeholder="Título do chamado" className="w-full px-4 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm focus:outline-none focus:border-emerald-500/40" />
                  <textarea value={novoDesc} onChange={(e) => setNovoDesc(e.target.value)} placeholder="Descreva o problema..." rows={5} className="w-full px-4 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm focus:outline-none focus:border-emerald-500/40 resize-none" />
                  <div className="flex gap-2">
                    <select value={novoPrioridade} onChange={(e) => setNovoPrioridade(e.target.value)} className="px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs cursor-pointer">
                      <option value="baixa">Prioridade: Baixa</option>
                      <option value="media">Prioridade: Média</option>
                      <option value="alta">Prioridade: Alta</option>
                      <option value="critica">Prioridade: Crítica</option>
                    </select>
                    <select value={novoMaquinaId} onChange={(e) => setNovoMaquinaId(e.target.value)} className="px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs cursor-pointer flex-1">
                      <option value="">Máquina (opcional)</option>
                      {maquinasList.map((m) => <option key={m.id} value={m.id}>{m.apelido || m.hostname}</option>)}
                    </select>
                  </div>
                  <button onClick={criarChamado} className="px-5 py-2.5 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-sm font-semibold text-emerald-300 cursor-pointer">Abrir Chamado</button>
                </div>
              ) : chamadoSel ? (
                <div className="max-w-3xl space-y-4">
                  <div>
                    <h3 className="text-lg font-bold text-white">{chamadoSel.chamado.titulo}</h3>
                    <p className="text-[11px] text-zinc-500 mt-1">Aberto por {chamadoSel.chamado.abertoPorEmail} · {new Date(chamadoSel.chamado.criadoEm).toLocaleString()}</p>
                  </div>
                  <div className="flex flex-wrap gap-2 items-center">
                    <select value={chamadoSel.chamado.status} onChange={(e) => patchChamado(chamadoSel.chamado.id, { status: e.target.value })} className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 cursor-pointer">
                      <option value="aberto">Aberto</option>
                      <option value="em_andamento">Em andamento</option>
                      <option value="resolvido">Resolvido</option>
                      <option value="fechado">Fechado</option>
                    </select>
                    <select value={chamadoSel.chamado.prioridade} onChange={(e) => patchChamado(chamadoSel.chamado.id, { prioridade: e.target.value })} className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 cursor-pointer">
                      <option value="baixa">Baixa</option>
                      <option value="media">Média</option>
                      <option value="alta">Alta</option>
                      <option value="critica">Crítica</option>
                    </select>
                    <select value={chamadoSel.chamado.atribuidoA || ""} onChange={(e) => patchChamado(chamadoSel.chamado.id, { atribuidoA: e.target.value || null })} className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 cursor-pointer">
                      <option value="">Não atribuído</option>
                      {(chamadoSel.usuarios || []).map((u: any) => <option key={u.id} value={u.id}>{u.email}</option>)}
                    </select>
                  </div>
                  <div className="p-4 rounded-xl bg-zinc-900/40 border border-zinc-800 text-sm text-zinc-300 whitespace-pre-wrap">{chamadoSel.chamado.descricao}</div>
                  <div className="space-y-2">
                    <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Comentários ({chamadoSel.comentarios.length})</span>
                    {chamadoSel.comentarios.map((cm: any) => (
                      <div key={cm.id} className="p-3 rounded-lg bg-zinc-900/30 border border-zinc-800/60 text-xs">
                        <div className="text-emerald-300/80 font-semibold text-[10px]">{cm.autorEmail} · <span className="text-zinc-500 font-normal">{new Date(cm.criadoEm).toLocaleString()}</span></div>
                        <div className="text-zinc-200 mt-1 whitespace-pre-wrap">{cm.texto}</div>
                      </div>
                    ))}
                    <div className="flex gap-2 pt-1">
                      <input value={comentarioTexto} onChange={(e) => setComentarioTexto(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") comentarChamado(chamadoSel.chamado.id); }} placeholder="Escreva um comentário e Enter..." className="flex-1 px-4 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs focus:outline-none focus:border-emerald-500/40" />
                      <button onClick={() => comentarChamado(chamadoSel.chamado.id)} className="px-4 py-2 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-xs font-semibold text-emerald-300 cursor-pointer">Comentar</button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-sm text-zinc-600">Selecione um chamado à esquerda ou crie um novo.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Gerência de Usuários */}
      {vistaUsuarios && (
        <div className="fixed inset-0 z-40 bg-zinc-950 flex flex-col animate-in fade-in duration-150">
          <div className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between bg-zinc-950/60 backdrop-blur">
            <h2 className="text-lg font-bold text-white flex items-center gap-2.5">
              <svg className="w-5 h-5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
              Usuários
              <span className="px-2 py-0.5 rounded-full bg-zinc-800 border border-zinc-700 text-xs text-zinc-400 font-normal">{usuariosList.length}</span>
            </h2>
            <button onClick={() => setVistaUsuarios(false)} className="px-4 py-2 rounded-xl bg-zinc-900 border border-zinc-800 hover:text-red-400 hover:border-red-500/30 text-zinc-400 text-xs font-semibold cursor-pointer">Fechar ✕</button>
          </div>
          <div className="flex-1 overflow-y-auto p-6">
            <div className="max-w-3xl mx-auto w-full space-y-5">
              <div className="glass-panel rounded-2xl p-4 border border-zinc-800 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <svg className="w-3.5 h-3.5 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                    </svg>
                    Notificações externas
                  </h3>
                  <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
                    <input type="checkbox" checked={notifCfg.ativo} onChange={(e) => setNotifCfg({ ...notifCfg, ativo: e.target.checked })} className="w-4 h-4 accent-emerald-500" />
                    Ativo
                  </label>
                </div>
                <p className="text-[10px] text-zinc-500">Receba os alertas (máquina caiu, watchdog, etc.) no seu canal. Cole a URL do webhook.</p>
                <div className="flex flex-wrap gap-2">
                  <select value={notifCfg.formato} onChange={(e) => setNotifCfg({ ...notifCfg, formato: e.target.value })} className="px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs cursor-pointer">
                    <option value="generico">Genérico (JSON)</option>
                    <option value="slack">Slack / Discord</option>
                    <option value="telegram">Telegram</option>
                  </select>
                  <select value={notifCfg.minSeveridade} onChange={(e) => setNotifCfg({ ...notifCfg, minSeveridade: e.target.value })} className="px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs cursor-pointer">
                    <option value="info">A partir de: Info</option>
                    <option value="aviso">A partir de: Aviso</option>
                    <option value="critico">A partir de: Crítico</option>
                  </select>
                </div>
                <input value={notifCfg.webhookUrl} onChange={(e) => setNotifCfg({ ...notifCfg, webhookUrl: e.target.value })} placeholder="https://... (URL do webhook)" className="w-full px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm focus:outline-none focus:border-emerald-500/40" />
                {notifCfg.formato === "telegram" && (
                  <input value={notifCfg.telegramChatId} onChange={(e) => setNotifCfg({ ...notifCfg, telegramChatId: e.target.value })} placeholder="chat_id do Telegram" className="w-full px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm focus:outline-none focus:border-emerald-500/40" />
                )}
                <label className="flex items-center justify-between gap-3 p-3 rounded-xl bg-zinc-900/40 border border-zinc-800/60 cursor-pointer">
                  <div>
                    <div className="text-sm text-white flex items-center gap-2">
                      <svg className="w-3.5 h-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
                      </svg>
                      Relatório semanal automático
                    </div>
                    <div className="text-[11px] text-zinc-500 mt-0.5">Envia um resumo da frota (máquinas, online/offline, ações) toda semana pelo webhook acima.</div>
                  </div>
                  <input type="checkbox" checked={!!notifCfg.relatorioSemanal} onChange={(e) => setNotifCfg({ ...notifCfg, relatorioSemanal: e.target.checked })} className="w-4 h-4 accent-emerald-500 shrink-0" />
                </label>

                {/* E-mail (SMTP) */}
                <div className="p-3 rounded-xl bg-zinc-900/40 border border-zinc-800/60 space-y-2">
                  <label className="flex items-center justify-between gap-3 cursor-pointer">
                    <div>
                      <div className="text-sm text-white flex items-center gap-2">
                        <svg className="w-3.5 h-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>
                        </svg>
                        Enviar por e-mail (SMTP)
                      </div>
                      <div className="text-[11px] text-zinc-500">Relatórios e alertas também por e-mail.</div>
                    </div>
                    <input type="checkbox" checked={!!notifCfg.emailAtivo} onChange={(e) => setNotifCfg({ ...notifCfg, emailAtivo: e.target.checked })} className="w-4 h-4 accent-emerald-500 shrink-0" />
                  </label>
                  {notifCfg.emailAtivo && (
                    <div className="space-y-2 pt-1">
                      <div className="flex gap-2">
                        <input value={notifCfg.smtpHost} onChange={(e) => setNotifCfg({ ...notifCfg, smtpHost: e.target.value })} placeholder="Servidor SMTP (ex.: smtp.gmail.com)" className="flex-1 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs" />
                        <input type="number" value={notifCfg.smtpPort} onChange={(e) => setNotifCfg({ ...notifCfg, smtpPort: Number(e.target.value) })} placeholder="Porta" className="w-20 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs" />
                      </div>
                      <input value={notifCfg.smtpUser} onChange={(e) => setNotifCfg({ ...notifCfg, smtpUser: e.target.value })} placeholder="Usuário (e-mail)" className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs" />
                      <input type="password" value={notifCfg.smtpPass} onChange={(e) => setNotifCfg({ ...notifCfg, smtpPass: e.target.value })} placeholder={notifCfg.smtpDefinida ? "Senha (salva — deixe em branco p/ manter)" : "Senha / senha de app"} className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs" />
                      <input value={notifCfg.smtpFrom} onChange={(e) => setNotifCfg({ ...notifCfg, smtpFrom: e.target.value })} placeholder='Remetente (ex.: "Suporte" <suporte@gmtec.tec.br>)' className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs" />
                      <input value={notifCfg.emailDestinatarios} onChange={(e) => setNotifCfg({ ...notifCfg, emailDestinatarios: e.target.value })} placeholder="Destinatários (separados por vírgula)" className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs" />
                      <button onClick={testarEmail} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-[11px] font-semibold text-zinc-300 hover:text-white cursor-pointer transition-colors duration-150">
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                        Salvar + enviar e-mail de teste
                      </button>
                      <p className="text-[10px] text-zinc-600">Gmail: porta 587, e use uma <b>senha de app</b> (não a senha normal).</p>
                    </div>
                  )}
                </div>

                <div className="flex gap-2">
                  <button onClick={salvarNotif} className="px-4 py-2 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-xs font-semibold text-emerald-300 cursor-pointer">Salvar (exige MFA)</button>
                  <button onClick={testarNotif} className="px-4 py-2 rounded-xl bg-zinc-900 border border-zinc-800 hover:text-white text-xs font-semibold text-zinc-400 cursor-pointer">Enviar teste</button>
                </div>
              </div>

              {/* E) WhatsApp / Evolution API */}
              <div className="glass-panel rounded-2xl p-4 border border-zinc-800 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white">Alertas WhatsApp — Evolution API</h3>
                    <p className="text-[11px] text-zinc-500">Notifique alertas críticos e offline via WhatsApp.</p>
                  </div>
                </div>
                {!waCfg ? (
                  <div className="flex items-center gap-2 py-2 text-xs text-zinc-500">
                    <div className="w-3 h-3 border-2 border-zinc-800 border-t-emerald-500 rounded-full animate-spin"></div>
                    Carregando configuração…
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <input type="checkbox" id="wa-ativo" checked={waCfg.ativo} onChange={(e) => setWaCfg({ ...waCfg, ativo: e.target.checked })} className="w-4 h-4 accent-emerald-500" />
                      <label htmlFor="wa-ativo" className="text-xs text-zinc-300 cursor-pointer">Ativar notificações WhatsApp</label>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      <input value={waCfg.apiUrl} onChange={(e) => setWaCfg({ ...waCfg, apiUrl: e.target.value })} placeholder="URL da Evolution API (ex: https://api.seudominio.com)" className="px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs focus:outline-none focus:border-emerald-500/40" />
                      <input value={waCfg.instancia} onChange={(e) => setWaCfg({ ...waCfg, instancia: e.target.value })} placeholder="Nome da instância" className="px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs focus:outline-none focus:border-emerald-500/40" />
                      <input value={waCfg.apiKey} onChange={(e) => setWaCfg({ ...waCfg, apiKey: e.target.value })} placeholder="API Key" type="password" className="px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs focus:outline-none focus:border-emerald-500/40" />
                      <input value={waCfg.numero} onChange={(e) => setWaCfg({ ...waCfg, numero: e.target.value })} placeholder="Número destino (ex: 5511999998888)" className="px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs focus:outline-none focus:border-emerald-500/40" />
                    </div>
                    <div className="flex items-center gap-4 text-xs">
                      <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={waCfg.alertaCritico} onChange={(e) => setWaCfg({ ...waCfg, alertaCritico: e.target.checked })} className="accent-emerald-500" /> Alertas críticos</label>
                      <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={waCfg.alertaOffline} onChange={(e) => setWaCfg({ ...waCfg, alertaOffline: e.target.checked })} className="accent-emerald-500" /> Máquina offline</label>
                    </div>
                    {waMensagem && (
                      <div className={`text-xs px-3 py-2 rounded-lg ${waMensagem.tipo === "ok" ? "bg-emerald-500/10 text-emerald-300" : "bg-red-500/10 text-red-300"}`}>
                        {waMensagem.texto}
                      </div>
                    )}
                    {regWaMsg && (
                      <div className={`text-xs px-3 py-2 rounded-lg ${regWaMsg.tipo === "ok" ? "bg-emerald-500/10 text-emerald-300" : "bg-red-500/10 text-red-300"}`}>{regWaMsg.texto}</div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button onClick={salvarWaCfg} disabled={salvandoWa} className="px-4 py-2 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-xs font-semibold text-emerald-300 cursor-pointer disabled:opacity-50">
                        {salvandoWa ? "Salvando…" : "Salvar (exige MFA)"}
                      </button>
                      <button onClick={testarWa} disabled={testandoWa} className="px-4 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-xs text-zinc-400 hover:text-white cursor-pointer disabled:opacity-50">
                        {testandoWa ? "Enviando…" : "Enviar teste"}
                      </button>
                      {waCfg?.ativo && (
                        <button onClick={registrarWebhookWhatsApp} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300 hover:text-emerald-200 cursor-pointer transition-colors duration-150">
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z"/><path d="M8 2v16"/><path d="M16 6v16"/></svg>
                          Registrar webhook (aprovações)
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Telegram Bot API — alertas diretos */}
              <div className="glass-panel rounded-2xl p-4 border border-zinc-800 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400">
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                      <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white">Alertas Telegram — Bot API</h3>
                    <p className="text-[11px] text-zinc-500">Configure o bot do Telegram para receber alertas de CPU/RAM/disco/offline.</p>
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                    <input type="checkbox" checked={tgCfg.telegramAtivo} onChange={(e) => setTgCfg({...tgCfg, telegramAtivo: e.target.checked})} className="w-4 h-4 accent-emerald-500" />
                    Ativar alertas via Telegram Bot
                  </label>
                  {tgCfg.telegramAtivo && (
                    <div className="space-y-2">
                      <input value={tgCfg.telegramBotToken} onChange={(e) => setTgCfg({...tgCfg, telegramBotToken: e.target.value})} type="password" placeholder="Token do bot (ex: 123456:ABC-DEF...)" className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs" />
                      <input value={tgCfg.telegramChatIdBot} onChange={(e) => setTgCfg({...tgCfg, telegramChatIdBot: e.target.value})} placeholder="Chat ID (ex: -100123456789 ou 123456789)" className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs" />
                      <p className="text-[10px] text-zinc-600">Use <b>/getUpdates</b> no bot para descobrir o chat_id do seu grupo ou canal.</p>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-3 pt-1">
                    <span className="text-[11px] text-zinc-400">Receber alertas do tipo:</span>
                    <label className="flex items-center gap-1.5 text-xs cursor-pointer"><input type="checkbox" checked={tgCfg.notifCritico} onChange={(e) => setTgCfg({...tgCfg, notifCritico: e.target.checked})} className="accent-red-500" /> <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0"></span> Crítico</label>
                    <label className="flex items-center gap-1.5 text-xs cursor-pointer"><input type="checkbox" checked={tgCfg.notifAviso} onChange={(e) => setTgCfg({...tgCfg, notifAviso: e.target.checked})} className="accent-orange-500" /> <span className="w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0"></span> Aviso</label>
                    <label className="flex items-center gap-1.5 text-xs cursor-pointer"><input type="checkbox" checked={tgCfg.notifOffline} onChange={(e) => setTgCfg({...tgCfg, notifOffline: e.target.checked})} className="accent-zinc-500" /> <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 shrink-0"></span> Offline</label>
                  </div>
                  {testeTgMsg && (
                    <div className={`text-xs px-3 py-2 rounded-lg ${testeTgMsg.tipo === "ok" ? "bg-emerald-500/10 text-emerald-300" : "bg-red-500/10 text-red-300"}`}>{testeTgMsg.texto}</div>
                  )}
                  {regTgMsg && (
                    <div className={`text-xs px-3 py-2 rounded-lg ${regTgMsg.tipo === "ok" ? "bg-blue-500/10 text-blue-300" : "bg-red-500/10 text-red-300"}`}>{regTgMsg.texto}</div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button onClick={salvarTgCfg} disabled={salvandoTg} className="px-4 py-2 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-xs font-semibold text-emerald-300 cursor-pointer disabled:opacity-50">
                      {salvandoTg ? "Salvando…" : "Salvar"}
                    </button>
                    {tgCfg.telegramAtivo && (
                      <>
                        <button onClick={testarTelegram} disabled={salvandoTg} className="px-4 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-xs text-zinc-400 hover:text-white cursor-pointer disabled:opacity-50">
                          Enviar teste
                        </button>
                        <button onClick={registrarWebhookTelegram} disabled={salvandoTg} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-500/10 border border-blue-500/30 text-xs text-blue-300 hover:text-blue-200 cursor-pointer disabled:opacity-50 transition-colors duration-150">
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z"/><path d="M8 2v16"/><path d="M16 6v16"/></svg>
                          Registrar webhook (aprovações)
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div className="glass-panel rounded-2xl p-4 border border-zinc-800 space-y-3">
                <h3 className="text-sm font-bold text-white">Novo usuário</h3>
                <div className="flex flex-wrap gap-2">
                  <input value={novoUserEmail} onChange={(e) => setNovoUserEmail(e.target.value)} placeholder="email@empresa.com" className="flex-1 min-w-[180px] px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm focus:outline-none focus:border-emerald-500/40" />
                  <input value={novoUserSenha} onChange={(e) => setNovoUserSenha(e.target.value)} type="password" placeholder="senha (mín. 8)" className="px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm focus:outline-none focus:border-emerald-500/40" />
                  <select value={novoUserPapel} onChange={(e) => setNovoUserPapel(e.target.value)} className="px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs cursor-pointer">
                    <option value="admin">Admin</option>
                    <option value="operator">Operador</option>
                    <option value="viewer">Leitura</option><option value="cliente">Cliente (portal)</option>
                  </select>
                  <button onClick={criarUsuario} className="px-4 py-2 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-sm font-semibold text-emerald-300 cursor-pointer">Criar</button>
                </div>
                <p className="text-[10px] text-zinc-500">Exige seu MFA. Papéis: <b>Admin</b> (gerencia tudo), <b>Operador</b> (opera máquinas), <b>Leitura</b> (só visualiza).</p>
              </div>
              <div className="space-y-2">
                {usuariosList.map((u) => (
                  <div key={u.id} className="p-3 rounded-xl bg-zinc-900/40 border border-zinc-800 space-y-2 hover:border-zinc-700 transition-colors duration-150">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        {/* Avatar por iniciais */}
                        {(() => {
                          const initials = (u.email || "?").slice(0, 2).toUpperCase();
                          const colors = ["bg-violet-500/20 text-violet-300", "bg-emerald-500/20 text-emerald-300", "bg-sky-500/20 text-sky-300", "bg-amber-500/20 text-amber-300", "bg-red-500/20 text-red-300"];
                          const colorIdx = u.email ? u.email.charCodeAt(0) % colors.length : 0;
                          return (
                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-[11px] font-bold shrink-0 ${colors[colorIdx]}`}>
                              {initials}
                            </div>
                          );
                        })()}
                        <div className="min-w-0">
                          <div className="text-sm text-white truncate">{u.email} {!u.ativo && <span className="text-red-400 text-[10px]">(inativo)</span>}</div>
                          <div className="text-[10px] text-zinc-500 flex items-center gap-1.5 mt-0.5">
                            {u.mfaAtivo ? (
                              <>
                                <svg className="w-2.5 h-2.5 text-emerald-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                                <span className="text-emerald-600">MFA ativo</span>
                              </>
                            ) : (
                              <>
                                <svg className="w-2.5 h-2.5 text-amber-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                                <span className="text-amber-600">sem MFA</span>
                              </>
                            )}
                            <span className="text-zinc-700">·</span>
                            último login: {u.ultimoLogin ? new Date(u.ultimoLogin).toLocaleString() : "nunca"}
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-2 items-center shrink-0">
                        {u.papel === "owner" ? (
                          <span className="text-xs text-emerald-300 px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/30 font-semibold">owner</span>
                        ) : (
                          <>
                            <select value={u.papel} onChange={(e) => patchUsuario(u.id, { papel: e.target.value })} className="px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 cursor-pointer">
                              <option value="admin">Admin</option>
                              <option value="operator">Operador</option>
                              <option value="viewer">Leitura</option><option value="cliente">Cliente (portal)</option>
                            </select>
                            <button onClick={() => patchUsuario(u.id, { ativo: !u.ativo })} className={`px-2.5 py-1.5 rounded-lg border text-[10px] font-semibold cursor-pointer ${u.ativo ? "bg-red-500/10 text-red-300 border-red-500/30" : "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"}`}>{u.ativo ? "Desativar" : "Ativar"}</button>
                            <button onClick={async () => { const s = await pedirTexto("Nova senha (mín. 8 caracteres):", ""); if (s && s.length >= 8) patchUsuario(u.id, { senha: s }); else if (s) mostrarToast("Mínimo 8 caracteres.", "aviso"); }} className="px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-[10px] font-semibold text-zinc-400 hover:text-white cursor-pointer">Resetar senha</button>
                            {u.mfaAtivo && <button onClick={() => { if (confirm("Resetar o MFA deste usuário? Ele vai configurar de novo no próximo login.")) patchUsuario(u.id, { resetarMfa: true }); }} className="px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[10px] font-semibold text-amber-300 hover:text-amber-200 cursor-pointer">Resetar MFA</button>}
                            {u.papel !== "owner" && u.id !== user?.id && <button onClick={() => excluirUsuario(u.id, u.email)} className="px-2.5 py-1.5 rounded-lg bg-red-500/10 border border-red-500/30 text-[10px] font-semibold text-red-300 hover:text-red-200 cursor-pointer">Excluir</button>}
                          </>
                        )}
                      </div>
                    </div>
                    {u.papel !== "owner" && u.papel !== "admin" && (
                      <div className="flex items-center gap-1.5 flex-wrap pt-1 border-t border-zinc-800/60">
                        <span className="text-[10px] text-zinc-500 mr-1 flex items-center gap-1">
                          <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18M6 21V7l6-4 6 4v14"/><path d="M9 21v-4h6v4"/></svg>
                          Empresas:
                        </span>
                        <button
                          onClick={() => patchUsuario(u.id, { empresasPermitidas: null })}
                          className={`px-2 py-0.5 rounded-md text-[10px] border cursor-pointer ${!u.empresasPermitidas || u.empresasPermitidas.length === 0 ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40 font-semibold" : "bg-zinc-900 text-zinc-500 border-zinc-800 hover:text-zinc-300"}`}
                        >Todas</button>
                        {empresas.map((emp) => {
                          const sel = (u.empresasPermitidas || []).includes(emp.id);
                          return (
                            <button
                              key={emp.id}
                              onClick={() => {
                                const atual: string[] = u.empresasPermitidas || [];
                                const novo = sel ? atual.filter((x: string) => x !== emp.id) : [...atual, emp.id];
                                patchUsuario(u.id, { empresasPermitidas: novo.length === 0 ? null : novo });
                              }}
                              className={`px-2 py-0.5 rounded-md text-[10px] border cursor-pointer ${sel ? "bg-cyan-500/15 text-cyan-300 border-cyan-500/40 font-semibold" : "bg-zinc-900 text-zinc-500 border-zinc-800 hover:text-zinc-300"}`}
                            >{emp.nome}</button>
                          );
                        })}
                        {(u.empresasPermitidas || []).length > 0 && <span className="text-[9px] text-amber-400/80 ml-1">restrito · vale no próximo login</span>}
                      </div>
                    )}
                    {u.papel !== "owner" && (
                      <div className="flex items-start gap-1.5 flex-wrap pt-1 border-t border-zinc-800/60">
                        <span className="text-[10px] text-zinc-500 mr-1 mt-0.5 flex items-center gap-1">
                          <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
                          Permissões:
                        </span>
                        <button
                          onClick={() => patchUsuario(u.id, { permissoes: null })}
                          className={`px-2 py-0.5 rounded-md text-[10px] border cursor-pointer ${!u.permissoes ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40 font-semibold" : "bg-zinc-900 text-zinc-500 border-zinc-800 hover:text-zinc-300"}`}
                        >Padrão do papel</button>
                        {CAPS_LISTA.map((cap) => {
                          const sel = (u.permissoesEfetivas || []).includes(cap);
                          return (
                            <button
                              key={cap}
                              onClick={() => {
                                const atual: string[] = u.permissoes || u.permissoesEfetivas || [];
                                const novo = sel ? atual.filter((x: string) => x !== cap) : Array.from(new Set([...atual, cap]));
                                patchUsuario(u.id, { permissoes: novo });
                              }}
                              className={`px-2 py-0.5 rounded-md text-[10px] border cursor-pointer ${sel ? "bg-violet-500/15 text-violet-300 border-violet-500/40 font-semibold" : "bg-zinc-900 text-zinc-500 border-zinc-800 hover:text-zinc-300"}`}
                            >{CAPS_LABEL[cap]}</button>
                          );
                        })}
                        {u.permissoes && <span className="text-[9px] text-amber-400/80 ml-1">personalizado · vale no próximo login</span>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Cadastro */}
      {modalAberto && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="w-full max-w-2xl glass-panel-neon rounded-2xl relative border border-zinc-800 animate-in zoom-in-95 duration-200 max-h-[92vh] flex flex-col">
            {/* Header fixo */}
            <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-zinc-800/60 shrink-0">
              <h3 className="text-xl font-bold text-white flex items-center gap-2">
                <span className="w-2.5 h-2.5 bg-emerald-500 rounded-full glow-emerald"></span>
                Cadastrar Novo Dispositivo
              </h3>
              <button
                onClick={() => setModalAberto(false)}
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-red-500/30 text-zinc-400 hover:text-red-400 text-sm font-bold transition-colors cursor-pointer shrink-0"
                title="Fechar"
              >
                ✕
              </button>
            </div>

            {/* Conteúdo scrollável */}
            <div className="flex-1 overflow-y-auto">
            {gerandoToken ? (
              <div className="flex flex-col items-center justify-center py-16">
                <span className="w-8 h-8 border-3 border-zinc-700 border-t-emerald-500 rounded-full animate-spin"></span>
                <p className="text-zinc-500 text-xs mt-3">Gerando token de cadastro temporário...</p>
              </div>
            ) : (
              <div className="space-y-6 p-6">
                <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-4 text-xs text-zinc-400 leading-relaxed">
                  <span className="font-bold text-zinc-300 block mb-1">Como funciona o cadastro?</span>
                  O token abaixo é temporário e possui validade de 24 horas para 1 único cadastro de agente. Ao executar o comando PowerShell na máquina monitorada, o agente gerará seu par de chaves RSA locais e enviará a chave pública PEM assinada pelo token para o gateway, ativando o mTLS fim-a-fim de forma transparente.
                </div>

                {/* Bloco de Token */}
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                    Token de Cadastro
                  </label>
                  <div className="flex gap-2">
                    <input
                      type={mostrarToken ? "text" : "password"}
                      readOnly
                      value={tokenGerado}
                      className="flex-1 px-4 py-3 rounded-xl bg-zinc-950 border border-zinc-900 text-zinc-300 font-mono text-xs focus:outline-none"
                    />
                    <button
                      onClick={() => setMostrarToken(v => !v)}
                      className="px-3 py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs text-zinc-400 cursor-pointer transition-colors"
                      title={mostrarToken ? "Ocultar token" : "Mostrar token"}
                    >
                      {mostrarToken ? "🙈" : "👁"}
                    </button>
                    <button
                      onClick={() => copiarParaTransferência(tokenGerado, setCopiouToken)}
                      className="px-4 py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs text-zinc-300 cursor-pointer font-semibold transition-colors flex items-center justify-center min-w-[70px]"
                    >
                      {copiouToken ? "Copiado!" : "Copiar"}
                    </button>
                  </div>
                </div>

                {/* Bloco de Comando PowerShell */}
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                    Comando de Instalação (PowerShell)
                  </label>
                  <div className="space-y-2">
                    <pre className="w-full p-4 rounded-xl bg-zinc-950 border border-zinc-900 text-emerald-400 font-mono text-xs overflow-x-auto leading-relaxed select-all">
                      {comandoPowerShell}
                    </pre>
                    <button
                      onClick={() => copiarParaTransferência(comandoPowerShell, setCopiouComando)}
                      className="w-full py-3 rounded-xl bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 hover:border-emerald-500/30 text-xs text-zinc-300 font-semibold cursor-pointer transition-colors flex items-center justify-center gap-1.5"
                    >
                      {copiouComando ? "Comando Copiado!" : "Copiar Comando de Instalação"}
                    </button>
                  </div>
                </div>

                {/* Bloco de Comando Linux */}
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                    Comando de Instalação (Linux — Ubuntu/Debian/RHEL/Fedora)
                  </label>
                  <div className="space-y-2">
                    <pre className="w-full p-4 rounded-xl bg-zinc-950 border border-zinc-900 text-sky-400 font-mono text-xs overflow-x-auto leading-relaxed select-all">
                      {comandoLinux}
                    </pre>
                    <button
                      onClick={() => copiarParaTransferência(comandoLinux, setCopiouLinux)}
                      className="w-full py-3 rounded-xl bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 hover:border-sky-500/30 text-xs text-zinc-300 font-semibold cursor-pointer transition-colors flex items-center justify-center gap-1.5"
                    >
                      {copiouLinux ? "Copiado!" : "Copiar Comando Linux"}
                    </button>
                  </div>
                  <p className="text-[10px] text-zinc-600 mt-1.5">Execute como root (sudo). Requer Node.js 18+ ou instalação automática via NodeSource.</p>
                </div>

                {/* Bloco de Comando macOS */}
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                    Comando de Instalação (macOS 12+ — Intel &amp; Apple Silicon)
                  </label>
                  <div className="space-y-2">
                    <pre className="w-full p-4 rounded-xl bg-zinc-950 border border-zinc-900 text-violet-400 font-mono text-xs overflow-x-auto leading-relaxed select-all">
                      {comandoMac}
                    </pre>
                    <button
                      onClick={() => copiarParaTransferência(comandoMac, setCopiouMac)}
                      className="w-full py-3 rounded-xl bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 hover:border-violet-500/30 text-xs text-zinc-300 font-semibold cursor-pointer transition-colors flex items-center justify-center gap-1.5"
                    >
                      {copiouMac ? "Copiado!" : "Copiar Comando macOS"}
                    </button>
                  </div>
                  <p className="text-[10px] text-zinc-600 mt-1.5">Instala como LaunchDaemon (root). Homebrew detectado automaticamente. Tela remota usa screencapture + osascript.</p>
                </div>

                {/* Bloco Android */}
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                    <span className="inline-flex items-center gap-1.5">
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="18" r="0.5" fill="currentColor"/></svg>
                      Instalação Android (APK — sem root)
                    </span>
                  </label>
                  <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-4 space-y-3">
                    <p className="text-xs text-zinc-400 leading-relaxed">
                      Baixe e instale o APK diretamente no dispositivo Android. Nenhum root necessário — o agente usa
                      <span className="text-amber-400 font-semibold"> MediaProjection</span> para tela remota e
                      <span className="text-amber-400 font-semibold"> AccessibilityService</span> para controle remoto.
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        readOnly
                        value={tokenGerado}
                        className="flex-1 px-3 py-2.5 rounded-xl bg-zinc-950 border border-zinc-900 text-zinc-300 font-mono text-xs focus:outline-none"
                        placeholder="Token de cadastro"
                      />
                      <button
                        onClick={() => copiarParaTransferência(tokenGerado, setCopiouAndroid)}
                        className="px-4 py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs text-zinc-300 cursor-pointer font-semibold transition-colors flex items-center justify-center min-w-[70px]"
                      >
                        {copiouAndroid ? "Copiado!" : "Copiar token"}
                      </button>
                    </div>
                    <a
                      href={urlApkAndroid}
                      download
                      className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-400 font-semibold text-xs transition-colors"
                    >
                      ⬇ Baixar nexus-rmm-agent.apk
                    </a>
                    <ol className="text-[10px] text-zinc-500 space-y-1 pl-3 list-decimal">
                      <li>Habilite <strong className="text-zinc-400">Instalar apps desconhecidos</strong> no Android (Configurações → Segurança)</li>
                      <li>Instale o APK e abra o app <strong className="text-zinc-400">Nexus RMM Agent</strong></li>
                      <li>Digite a URL do servidor: <code className="text-emerald-400">{`${protocol}//${host}`}</code></li>
                      <li>Cole o token acima e toque em <strong className="text-zinc-400">Cadastrar</strong></li>
                      <li>Ative o serviço de Acessibilidade quando solicitado (necessário para controle remoto)</li>
                      <li>Aprove a captura de tela quando o painel solicitar tela remota (permissão Android)</li>
                    </ol>
                  </div>
                </div>

                <div className="flex justify-end pt-4 border-t border-zinc-800/40">
                  <button
                    onClick={() => setModalAberto(false)}
                    className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-black font-semibold text-xs transition-colors cursor-pointer"
                  >
                    Pronto
                  </button>
                </div>
              </div>
            )}
            </div>{/* fim overflow-y-auto */}
          </div>
        </div>
      )}

      {/* Drawer de Gerenciamento da Máquina */}
      {maquinaServicos && (
        <>
          <div className="fixed inset-0 z-40 bg-zinc-950 flex flex-col animate-in fade-in duration-150">
            {/* Header */}
            <div className="px-4 md:px-6 py-3 border-b border-zinc-800/80 flex items-start justify-between gap-3 bg-zinc-950/80 backdrop-blur-md shrink-0">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-bold text-white text-sm md:text-base">Gerenciamento da Máquina</h3>
                  <span className="text-xs text-zinc-500 font-mono truncate max-w-[200px]">{maquinaServicos.apelido || maquinaServicos.hostname}</span>
                  {maquinaServicos.versaoAgente && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-700 text-zinc-500 font-mono text-[10px]">
                      v{maquinaServicos.versaoAgente}
                    </span>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-2 items-start">
                  <div className="flex-1 min-w-[140px]">
                    <label className="text-[10px] text-zinc-500 flex items-center gap-1 mb-1">
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18M6 21V7l6-4 6 4v14"/><path d="M9 21v-4h6v4"/></svg>
                      Empresa / Depto
                    </label>
                    <select
                      value={maquinaServicos.grupoId ?? ""}
                      onChange={(e) => { const v = e.target.value === "" ? null : e.target.value; atribuirMaquina(maquinaServicos.id, { grupoId: v }); setMaquinaServicos({ ...maquinaServicos, grupoId: v }); }}
                      className="bg-zinc-900 border border-zinc-800 rounded-lg text-xs text-zinc-200 px-2.5 py-1.5 focus:outline-none focus:border-emerald-500/40 cursor-pointer w-full"
                    >
                      <option value="">— Sem empresa —</option>
                      {empresas.map((emp) => (
                        <optgroup key={emp.id} label={emp.nome}>
                          <option value={emp.id}>{emp.nome} (empresa toda)</option>
                          {departamentosDe(emp.id).map((dep) => <option key={dep.id} value={dep.id}>↳ {dep.nome}</option>)}
                        </optgroup>
                      ))}
                    </select>
                    {empresas.length === 0 && <p className="text-[10px] text-amber-300/80 mt-1">Nenhuma empresa ainda — crie na lista.</p>}
                  </div>
                  <div className="flex-1 min-w-[120px]">
                    <label className="text-[10px] text-zinc-500 flex items-center gap-1 mb-1">
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.5" fill="currentColor" stroke="none"/></svg>
                      Tags
                    </label>
                    <div className="flex flex-wrap gap-1 items-center">
                      {(maquinaServicos.tags || []).map((t: string) => (
                        <span key={t} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-[10px] text-emerald-300">
                          {t}<button onClick={() => removerTag(maquinaServicos, t)} className="hover:text-white cursor-pointer">×</button>
                        </span>
                      ))}
                      <input value={novaTag} onChange={(e) => setNovaTag(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { adicionarTag(maquinaServicos, novaTag); setNovaTag(""); } }} placeholder="+ tag" className="bg-zinc-900 border border-zinc-800 rounded-md text-[10px] text-zinc-200 px-2 py-1 w-20 focus:outline-none focus:border-emerald-500/40" />
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {maquinaServicos.online && (
                  <button
                    onClick={() => reiniciarAgente(maquinaServicos.id)}
                    title="Reiniciar serviço nexus-agente"
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 text-xs font-semibold transition-colors cursor-pointer"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                    </svg>
                    Reiniciar agente
                  </button>
                )}
                <button
                  onClick={() => setMaquinaServicos(null)}
                  className="w-8 h-8 flex items-center justify-center shrink-0 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-red-500/30 text-zinc-400 hover:text-red-400 text-sm font-bold transition-colors cursor-pointer"
                  title="Fechar"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Abas */}
            <div className="flex border-b border-zinc-800 bg-zinc-950 px-6 overflow-x-auto">
              <button
                onClick={() => setAbaAtiva("visao")}
                className={`py-3 px-4 text-xs font-bold border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                  abaAtiva === "visao"
                    ? "border-emerald-500 text-emerald-400"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                📊 Visão Geral
              </button>
              {temFeature("servicos") && (
              <button
                onClick={() => setAbaAtiva("servicos")}
                className={`py-3 px-4 text-xs font-bold border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                  abaAtiva === "servicos"
                    ? "border-emerald-500 text-emerald-400"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                Serviços do Windows
              </button>
              )}
              <button
                onClick={() => {
                  setAbaAtiva("inventario");
                  carregarInventario(maquinaServicos.id);
                }}
                className={`py-3 px-4 text-xs font-bold border-b-2 transition-colors cursor-pointer ${
                  abaAtiva === "inventario"
                    ? "border-emerald-500 text-emerald-400"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                Ficha Técnica / Inventário
              </button>
              <button
                onClick={() => {
                  setAbaAtiva("logs");
                  carregarLogs(maquinaServicos.id);
                }}
                className={`py-3 px-4 text-xs font-bold border-b-2 transition-colors cursor-pointer ${
                  abaAtiva === "logs"
                    ? "border-emerald-500 text-emerald-400"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                Histórico / Auditoria
              </button>
              <button
                onClick={() => setAbaAtiva("terminal")}
                className={`py-3 px-4 text-xs font-bold border-b-2 transition-colors cursor-pointer ${
                  abaAtiva === "terminal"
                    ? "border-emerald-500 text-emerald-400"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                Terminal
              </button>
              {temFeature("arquivos") && (
              <button
                onClick={() => { setAbaAtiva("arquivos"); if (arquivosItens.length === 0) listarArquivos(""); }}
                className={`py-3 px-4 text-xs font-bold border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                  abaAtiva === "arquivos"
                    ? "border-emerald-500 text-emerald-400"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                Arquivos
              </button>
              )}
              {temFeature("manutencao") && (
              <button
                onClick={() => { setAbaAtiva("manutencao"); setRespEdit(maquinaServicos.responsavel || ""); carregarManutencoes(maquinaServicos.id); }}
                className={`py-3 px-4 text-xs font-bold border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                  abaAtiva === "manutencao"
                    ? "border-emerald-500 text-emerald-400"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                🔧 Manutenção
              </button>
              )}
            </div>

            {abaAtiva === "visao" ? (
              <div className="flex-1 overflow-y-auto p-6 space-y-5">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${maquinaServicos.online ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" : "bg-zinc-800 text-zinc-400 border-zinc-700"}`}>
                    {maquinaServicos.online ? (
                      <span className="relative flex h-1.5 w-1.5">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
                      </span>
                    ) : (
                      <span className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
                    )}
                    {maquinaServicos.online ? "Online" : "Offline"}
                  </span>
                  <span className="text-xs text-zinc-500">Visto por último: {maquinaServicos.vistoEm ? new Date(maquinaServicos.vistoEm).toLocaleString() : "—"}</span>
                  <span className="text-xs text-zinc-500">· Agente v{(maquinaServicos as any).versaoAgente || "—"}</span>
                  {/* Botão Diagnóstico IA — aparece quando score < 60 ou offline */}
                  {(!maquinaServicos.online || (maquinaServicos.healthScore != null && maquinaServicos.healthScore < 60)) && (
                    <button
                      onClick={() => executarDiagnostico(maquinaServicos.id)}
                      className="ml-auto flex items-center gap-2 px-3 py-1.5 rounded-lg bg-violet-500/10 border border-violet-500/30 text-violet-300 text-xs font-semibold hover:bg-violet-500/20 transition-all cursor-pointer"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4m0 0h18" />
                      </svg>
                      Diagnóstico IA
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {[{ l: "CPU", v: metricas?.atual?.cpu, samples: (metricas?.amostras || []).map((a: any) => a.cpu) }, { l: "Memória RAM", v: metricas?.atual?.ram, samples: (metricas?.amostras || []).map((a: any) => a.ram) }].map((g) => {
                    const val = g.v == null ? 0 : Math.round(g.v);
                    const cor = val >= 90 ? "#ef4444" : val >= 70 ? "#f59e0b" : "#10b981";
                    return (
                      <div key={g.l} className="glass-panel rounded-2xl p-5 border border-zinc-800">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-bold text-zinc-300">{g.l}</span>
                          <span className="text-3xl font-bold font-mono" style={{ color: cor }}>{g.v == null ? "—" : val + "%"}</span>
                        </div>
                        <div className="h-2.5 rounded-full bg-zinc-800 overflow-hidden mb-3"><div className="h-full rounded-full transition-all duration-700" style={{ width: val + "%", background: cor }}></div></div>
                        <div className="flex items-end gap-0.5 h-10">
                          {g.samples.slice(-30).map((s: number, i: number) => (<div key={i} className="flex-1 rounded-sm" style={{ height: Math.max(2, s || 0) + "%", background: (s >= 90 ? "#ef4444" : s >= 70 ? "#f59e0b" : "#10b981") + "99" }}></div>))}
                          {g.samples.length === 0 && <span className="text-[10px] text-zinc-600">sem amostras</span>}
                        </div>
                        <div className="text-[9px] text-zinc-600 mt-1">{maquinaServicos.online ? "ao vivo · atualiza a cada ~10s" : "máquina offline — sem dados ao vivo"}</div>
                      </div>
                    );
                  })}
                </div>

                {discosPrevisao.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">Discos</div>
                    {discosPrevisao.map((d: any) => {
                      const cor = d.usoPct >= 85 ? "#ef4444" : d.usoPct >= 70 ? "#f59e0b" : "#10b981";
                      const previsaoTexto =
                        d.previsaoDias != null
                          ? d.previsaoDias <= 7
                            ? `Cheio em ~${d.previsaoDias} dias`
                            : d.previsaoDias <= 30
                            ? `~${d.previsaoDias} dias restantes`
                            : null
                          : null;
                      return (
                        <div key={d.caminho} className="glass-panel rounded-xl p-3 border border-zinc-800">
                          <div className="flex justify-between items-center mb-1.5">
                            <span className="text-xs font-mono text-zinc-300">{d.caminho}</span>
                            <span className="text-xs font-mono font-bold" style={{ color: cor }}>{d.usoPct}%</span>
                          </div>
                          <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
                            <div className="h-full rounded-full transition-all" style={{ width: `${d.usoPct}%`, background: cor }} />
                          </div>
                          {previsaoTexto && (
                            <p className="text-[10px] text-amber-400 mt-1.5 font-mono">{previsaoTexto}</p>
                          )}
                          {d.crescimentoPorDia > 0 && (
                            <p className="text-[10px] text-zinc-600 mt-0.5">+{d.crescimentoPorDia}%/dia</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="glass-panel rounded-2xl p-5 border border-zinc-800">
                  <h4 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
                    <svg className="w-3.5 h-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                      <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
                    </svg>
                    Discos
                  </h4>
                  {!(inventario?.hardware?.discos || []).length ? <p className="text-xs text-zinc-500">{inventario ? "Sem dados de disco." : "Carregando inventário…"}</p> :
                    <div className="space-y-3">
                      {inventario.hardware.discos.map((d: any, i: number) => {
                        const tot = Number(d.tamanhoBytes || d.Size || 0), livre = Number(d.livreBytes || d.FreeSpace || 0), usado = Math.max(0, tot - livre);
                        const pct = tot ? Math.round((usado / tot) * 100) : 0;
                        const cor = pct >= 90 ? "#ef4444" : pct >= 75 ? "#f59e0b" : "#10b981";
                        return (
                          <div key={i}>
                            <div className="flex justify-between text-[11px] mb-1"><span className="text-zinc-300 font-mono">{d.caminho || d.DeviceID || "disco"}</span><span className="text-zinc-400">{(usado / 1e9).toFixed(0)} / {(tot / 1e9).toFixed(0)} GB · {pct}%</span></div>
                            <div className="h-2 rounded-full bg-zinc-800 overflow-hidden"><div className="h-full rounded-full" style={{ width: pct + "%", background: cor }}></div></div>
                          </div>
                        );
                      })}
                    </div>}
                </div>

                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                  {([
                    { icon: <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>, l: "Sistema Operacional", v: inventario?.so?.nome ? `${inventario.so.nome} ${inventario.so.versao || ""}` : "—" },
                    { icon: <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="15" x2="23" y2="15"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="15" x2="4" y2="15"/></svg>, l: "CPU", v: inventario?.hardware?.cpu?.modelo || "—" },
                    { icon: <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="5" width="22" height="14" rx="2"/><line x1="8" y1="9" x2="8" y2="15"/><line x1="16" y1="9" x2="16" y2="15"/><line x1="12" y1="8" x2="12" y2="16"/></svg>, l: "RAM", v: inventario?.hardware?.ram?.totalBytes ? (inventario.hardware.ram.totalBytes / 1e9).toFixed(1) + " GB" : "—" },
                    { icon: <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>, l: "Hostname", v: maquinaServicos.hostname },
                    { icon: <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>, l: "Softwares", v: inventario?.software?.length || "—" },
                    { icon: <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>, l: "Tipo", v: maquinaServicos.tipoMaquina === "servidor" ? "Servidor" : maquinaServicos.tipoMaquina === "notebook" ? "Notebook" : maquinaServicos.tipoMaquina === "mobile" ? "Mobile" : maquinaServicos.tipoMaquina === "tablet" ? "Tablet" : "PC" },
                    { icon: <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1" fill="currentColor"/></svg>, l: "MAC (WoL)", v: maquinaServicos.macAddress || "—" },
                  ] as { icon: React.ReactNode; l: string; v: any }[]).map(({ icon, l, v }) => (
                    <div key={l} className="glass-panel rounded-xl p-3 border border-zinc-800">
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-zinc-600">{icon}</span>
                        <div className="text-[10px] text-zinc-500 uppercase tracking-wide">{l}</div>
                      </div>
                      <div className="text-zinc-200 truncate font-mono text-[11px]">{v}</div>
                    </div>
                  ))}
                </div>

                {/* Localização — só para dispositivos móveis */}
                {(maquinaServicos.tipoMaquina === "mobile" || maquinaServicos.tipoMaquina === "tablet") && (
                  <div className="glass-panel rounded-2xl p-5 border border-zinc-800">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-sm font-bold text-white">📍 Localização</h4>
                      {maquinaServicos.localizacaoEm && (
                        <span className="text-[10px] text-zinc-500">
                          atualizado {new Date(maquinaServicos.localizacaoEm).toLocaleString("pt-BR")}
                        </span>
                      )}
                    </div>
                    {maquinaServicos.latitude != null && maquinaServicos.longitude != null ? (
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-3 flex-wrap">
                          <span className="font-mono text-sm text-zinc-200">
                            {maquinaServicos.latitude.toFixed(6)}, {maquinaServicos.longitude.toFixed(6)}
                          </span>
                          {maquinaServicos.precisaoMetros != null && (
                            <span className="px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-700 text-[11px] text-zinc-400">
                              ±{Math.round(maquinaServicos.precisaoMetros)}m
                            </span>
                          )}
                        </div>
                        <a
                          href={`https://www.google.com/maps?q=${maquinaServicos.latitude},${maquinaServicos.longitude}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-xs font-semibold text-emerald-300 transition-colors w-fit"
                        >
                          🗺️ Ver no Google Maps
                        </a>
                      </div>
                    ) : (
                      <p className="text-xs text-zinc-500">
                        Aguardando localização — dispositivo pode estar com permissão negada ou sem sinal.
                      </p>
                    )}
                  </div>
                )}

                {/* A) Health Score — sparkline 7 dias */}
                <div className="glass-panel rounded-2xl p-5 border border-zinc-800">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-bold text-white flex items-center gap-2">
                      <svg className="w-3.5 h-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                      </svg>
                      Health Score — últimos 7 dias
                    </h4>
                    {carregandoHealthHistory && <span className="w-3.5 h-3.5 border-2 border-zinc-800 border-t-emerald-500 rounded-full animate-spin"></span>}
                  </div>
                  {!healthHistory || healthHistory.length === 0 ? (
                    <p className="text-xs text-zinc-500">{carregandoHealthHistory ? "Calculando…" : "Sem dados suficientes para traçar o histórico."}</p>
                  ) : (
                    <div className="flex items-end gap-1 h-16">
                      {healthHistory.map((p) => {
                        const cor = p.score >= 80 ? "#10b981" : p.score >= 60 ? "#f59e0b" : p.score >= 30 ? "#f97316" : "#ef4444";
                        const h = p.score === 0 ? 4 : Math.max(6, p.score * 0.6);
                        return (
                          <div key={p.data} className="flex-1 flex flex-col items-center gap-1 group relative">
                            <div className="rounded-sm w-full transition-all" style={{ height: h, background: cor + "cc" }}></div>
                            <span className="text-[9px] text-zinc-600">{new Date(p.data + "T12:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}</span>
                            <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-[10px] text-white whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none z-10">
                              Score: <b>{p.score}</b>{p.cpu != null ? ` · CPU ${p.cpu}%` : ""}{p.ram != null ? ` · RAM ${p.ram}%` : ""}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* D) Auto-remediação — só quando health score < 30 e máquina online */}
                {maquinaServicos.online && maquinaServicos.healthScore != null && maquinaServicos.healthScore < 30 && (
                  <div className="glass-panel rounded-2xl p-5 border border-red-500/20 bg-red-500/5">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-8 h-8 rounded-xl bg-red-500/15 border border-red-500/20 flex items-center justify-center text-red-400 shrink-0">
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                        </svg>
                      </div>
                      <div>
                        <h4 className="text-sm font-bold text-red-300">Health Score Crítico — Remediação Automática</h4>
                        <p className="text-[11px] text-zinc-400 mt-0.5">Limpa arquivos temporários, reinicia serviços parados e libera cache DNS.</p>
                      </div>
                    </div>
                    {remediacaoResultado ? (
                      <div className="space-y-2 mb-3">
                        {remediacaoResultado.resultados.map((r) => (
                          <div key={r.acao} className={`flex items-start gap-2 text-xs rounded-lg p-2 ${r.ok ? "bg-emerald-500/10 text-emerald-300" : "bg-red-500/10 text-red-300"}`}>
                            {r.ok ? (
                              <svg className="w-3.5 h-3.5 text-emerald-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                            ) : (
                              <svg className="w-3.5 h-3.5 text-red-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                            )}
                            <div><span className="font-bold capitalize">{r.acao}: </span>{r.output.slice(0, 120)}</div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <button
                      onClick={() => executarRemediacao(maquinaServicos.id)}
                      disabled={remediandoMaquina}
                      className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-500/15 border border-red-500/30 text-red-300 text-xs font-bold hover:bg-red-500/25 transition-all cursor-pointer disabled:opacity-50"
                    >
                      {remediandoMaquina ? <span className="w-3.5 h-3.5 border-2 border-red-800 border-t-red-400 rounded-full animate-spin"></span> : <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>}
                      {remediandoMaquina ? "Remediando…" : remediacaoResultado ? "Remediar novamente" : "Iniciar Remediação"}
                    </button>
                  </div>
                )}

                {/* Criticidade + IA remediação por máquina */}
                <div className="glass-panel rounded-2xl p-5 border border-zinc-800 space-y-4">
                  <h4 className="text-sm font-bold text-white flex items-center gap-2">
                    <svg className="w-3.5 h-3.5 text-violet-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>
                    </svg>
                    Criticidade e IA remediação
                  </h4>
                  <div>
                    <label className="block text-[10px] text-zinc-500 mb-1">Nível de criticidade desta máquina</label>
                    <select
                      value={maquinaServicos.criticidade || "operacional"}
                      onChange={(e) => setMaquinaServicos({...maquinaServicos, criticidade: e.target.value as any})}
                      className="w-full px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm cursor-pointer focus:outline-none focus:border-emerald-500/40"
                    >
                      <option value="operacional">Operacional — baixa prioridade</option>
                      <option value="importante">Importante — prioridade média</option>
                      <option value="critico">Crítico — alta prioridade (alerta crítico)</option>
                      <option value="missao_critica">Missão Crítica — alerta crítico imediato</option>
                    </select>
                    <p className="text-[10px] text-zinc-600 mt-1">Máquinas críticas e missão crítica geram alertas imediatos, não apenas avisos.</p>
                  </div>
                  <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-900/40 border border-zinc-800/60">
                    <div>
                      <div className="text-sm text-white flex items-center gap-2">
                        <svg className="w-3.5 h-3.5 text-violet-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/>
                        </svg>
                        Permitir IA remediação nesta máquina
                      </div>
                      <div className="text-[11px] text-zinc-500 mt-0.5">A IA só age se o interruptor global (em Segurança) e este estiverem ligados.</div>
                    </div>
                    <button
                      onClick={() => setMaquinaServicos({...maquinaServicos, iaRemediacao: !maquinaServicos.iaRemediacao})}
                      className={`shrink-0 w-12 h-6 rounded-full relative transition-colors cursor-pointer ${maquinaServicos.iaRemediacao ? "bg-emerald-500" : "bg-zinc-700"}`}
                    >
                      <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${maquinaServicos.iaRemediacao ? "left-6" : "left-0.5"}`}></span>
                    </button>
                  </div>
                  {maquinaServicos.iaRemediacao && iaCatalogo.length > 0 && (
                    <div>
                      <label className="block text-[10px] text-zinc-500 mb-2">Ações que a IA pode executar nesta máquina</label>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
                        {iaCatalogo.map((a) => (
                          <label key={a.id} className="flex items-center gap-2 text-xs cursor-pointer p-2 rounded-lg hover:bg-zinc-900/40">
                            <input
                              type="checkbox"
                              checked={(maquinaServicos.iaAcoesPermitidas || []).includes(a.id)}
                              onChange={(e) => {
                                const atuais = maquinaServicos.iaAcoesPermitidas || [];
                                setMaquinaServicos({...maquinaServicos, iaAcoesPermitidas: e.target.checked ? [...atuais, a.id] : atuais.filter(x => x !== a.id)});
                              }}
                              className="accent-emerald-500"
                            />
                            <span className="text-zinc-300">{a.desc}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                  <button
                    onClick={() => salvarIaMaquina(maquinaServicos.id, maquinaServicos.criticidade || "operacional", !!maquinaServicos.iaRemediacao, maquinaServicos.iaAcoesPermitidas || [])}
                    disabled={salvandoIaMaq}
                    className="px-4 py-2 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-xs font-semibold text-emerald-300 cursor-pointer disabled:opacity-50"
                  >
                    {salvandoIaMaq ? "Salvando…" : "Salvar configuração"}
                  </button>
                </div>
              </div>
            ) : abaAtiva === "servicos" ? (
              <>
                {/* Filtro de Serviços + Process Scan (H) */}
                <div className="px-6 py-4 border-b border-zinc-800/40 bg-zinc-950/20 space-y-3">
                  <div className="flex items-center gap-3">
                    <input
                      type="text"
                      placeholder="Filtrar por nome ou exibição..."
                      value={filtroServicos}
                      onChange={(e) => setFiltroServicos(e.target.value)}
                      className="flex-1 px-4 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs focus:outline-none focus:border-emerald-500/40"
                    />
                    <button
                      onClick={() => executarProcessScan(maquinaServicos.id)}
                      disabled={carregandoProcessScan}
                      className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-red-500/10 border border-red-500/25 text-red-300 text-xs font-bold hover:bg-red-500/20 transition-all cursor-pointer disabled:opacity-50 whitespace-nowrap"
                    >
                      {carregandoProcessScan ? <span className="w-3 h-3 border-2 border-red-800 border-t-red-400 rounded-full animate-spin"></span> : <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>}
                      {carregandoProcessScan ? "Varrendo…" : "Scan Malware"}
                    </button>
                  </div>
                  {/* Resultado do process scan */}
                  {processScan && (
                    <div className={`rounded-xl p-3 border ${processScan.criticos > 0 ? "border-red-500/30 bg-red-500/5" : processScan.total > 0 ? "border-amber-500/30 bg-amber-500/5" : "border-emerald-500/30 bg-emerald-500/5"}`}>
                      <div className="flex items-center justify-between mb-2">
                        <span className={`text-xs font-bold ${processScan.criticos > 0 ? "text-red-300" : processScan.total > 0 ? "text-amber-300" : "text-emerald-300"}`}>
                          {processScan.criticos > 0 ? `${processScan.criticos} ameaça(s) CRÍTICA(S) detectada(s)!` : processScan.total > 0 ? `${processScan.total} ameaça(s) encontrada(s)` : "Nenhuma ameaça detectada"}
                        </span>
                        <span className="text-[10px] text-zinc-500">{processScan.processosAnalisados} proc · modo: {processScan.modoAnalise}</span>
                      </div>
                      {processScan.ameacas.map((a: any, i: number) => (
                        <div key={i} className={`text-[11px] flex items-start gap-2 py-1 border-t border-zinc-800/40 ${a.risco === "critico" ? "text-red-300" : a.risco === "alto" ? "text-orange-300" : "text-amber-300"}`}>
                          <span className="font-bold uppercase text-[9px] mt-0.5 px-1.5 py-0.5 rounded bg-zinc-800">{a.risco}</span>
                          <div><span className="font-semibold">{a.nome}</span> <span className="text-zinc-500">— processo: {a.processo}</span></div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Listagem de Serviços */}
                <div className="flex-1 overflow-y-auto p-6 space-y-4">
                  {carregandoServicos ? (
                    <div className="flex flex-col items-center justify-center py-24">
                      <span className="w-8 h-8 border-3 border-zinc-800 border-t-emerald-500 rounded-full animate-spin"></span>
                      <p className="text-zinc-500 text-xs mt-3">Carregando serviços do agente...</p>
                    </div>
                  ) : servicosFiltrados.length === 0 ? (
                    <div className="text-center py-12 text-zinc-500 text-xs">
                      Nenhum serviço encontrado.
                    </div>
                  ) : (
                    servicosFiltrados.map((s: any) => (
                      <div
                        key={s.id}
                        className="p-4 rounded-xl bg-zinc-900/40 border border-zinc-800/60 flex items-center justify-between hover:bg-zinc-900/60 transition-colors"
                      >
                        <div className="min-w-0 flex-1 pr-3">
                          <div className="font-semibold text-white text-xs truncate" title={s.nome}>
                            {s.displayName || s.nome}
                          </div>
                          <div className="text-[10px] text-zinc-500 font-mono truncate">{s.nome}</div>
                          <div className="flex items-center gap-2 mt-2">
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold border ${
                                s.estado === "Running"
                                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                  : "bg-zinc-900 text-zinc-500 border-zinc-800"
                              }`}
                            >
                              <span
                                className={`w-1 h-1 rounded-full ${
                                  s.estado === "Running" ? "bg-emerald-500 glow-emerald" : "bg-zinc-600"
                                }`}
                              ></span>
                              {s.estado === "Running" ? "Executando" : "Parado"}
                            </span>
                            
                            {/* Startup Type Selector */}
                            <select
                              value={s.tipoInicializacao}
                              onChange={(e) => executarAcaoServico(s.nome, "CHANGE_TYPE", e.target.value)}
                              disabled={executandoAcao === s.nome}
                              className="bg-zinc-950 border border-zinc-800 rounded-md text-[10px] text-zinc-400 px-1.5 py-0.5 focus:outline-none focus:border-emerald-500/40 cursor-pointer"
                            >
                              <option value="Automatic">Automático</option>
                              <option value="Manual">Manual</option>
                              <option value="Disabled">Desativado</option>
                            </select>

                            {/* Watchdog (self-healing) */}
                            <button
                              onClick={() => toggleWatchdog(s.nome, !s.watchdogAtivo)}
                              disabled={executandoAcao === s.nome}
                              title={s.watchdogAtivo ? "Watchdog ATIVO — reinicia sozinho se cair. Clique para desativar." : "Ativar watchdog (reinicia o serviço sozinho se ele parar)"}
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold border transition-colors cursor-pointer disabled:opacity-50 ${
                                s.watchdogAtivo
                                  ? "bg-amber-500/15 text-amber-300 border-amber-500/40"
                                  : "bg-zinc-950 text-zinc-500 border-zinc-800 hover:text-amber-300"
                              }`}
                            >
                              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                              {s.watchdogAtivo ? "Watchdog ON" : "Watchdog"}
                            </button>
                          </div>
                        </div>

                        <div className="flex gap-1.5 shrink-0">
                          {executandoAcao === s.nome ? (
                            <span className="w-5 h-5 border-2 border-zinc-800 border-t-emerald-500 rounded-full animate-spin"></span>
                          ) : s.estado === "Running" ? (
                            <>
                              <button
                                onClick={() => executarAcaoServico(s.nome, "STOP")}
                                title="Parar Serviço"
                                className="w-7 h-7 rounded-lg bg-zinc-800 hover:bg-red-500/20 hover:text-red-400 border border-zinc-700 flex items-center justify-center text-xs transition-colors cursor-pointer text-zinc-400 font-bold"
                              >
                                ■
                              </button>
                              <button
                                onClick={() => executarAcaoServico(s.nome, "RESTART")}
                                title="Reiniciar Serviço"
                                className="w-7 h-7 rounded-lg bg-zinc-800 hover:bg-emerald-500/20 hover:text-emerald-400 border border-zinc-700 flex items-center justify-center text-xs transition-colors cursor-pointer text-zinc-400 font-bold"
                              >
                                ↻
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => executarAcaoServico(s.nome, "START")}
                              title="Iniciar Serviço"
                              className="w-7 h-7 rounded-lg bg-zinc-800 hover:bg-emerald-500/20 hover:text-emerald-400 border border-zinc-700 flex items-center justify-center text-xs transition-colors cursor-pointer text-zinc-400 font-bold"
                            >
                              ▶
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </>
            ) : abaAtiva === "inventario" ? (
              /* ABA DE INVENTÁRIO */
              <div className="flex-1 overflow-y-auto p-6 space-y-6">
                {metricas?.atual && (
                  <div className="grid grid-cols-2 gap-3">
                    {(["cpu", "ram"] as const).map((k) => {
                      const val = metricas.atual[k] || 0;
                      const cor = val >= 85 ? "#f87171" : val >= 60 ? "#fbbf24" : "#34d399";
                      const am = (metricas.amostras || []);
                      const n = am.length;
                      const pts = n > 1 ? am.map((a: any, i: number) => `${(i / (n - 1)) * 100},${24 - ((a[k] || 0) / 100) * 24}`).join(" ") : "";
                      return (
                        <div key={k} className="p-3 rounded-xl bg-zinc-900/40 border border-zinc-800/60">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 glow-emerald animate-pulse-subtle"></span>
                              {k === "cpu" ? "CPU" : "Memória"}
                            </span>
                            <span className="text-lg font-extrabold font-mono" style={{ color: cor }}>{val}%</span>
                          </div>
                          <div className="w-full bg-zinc-950 h-1.5 rounded-full overflow-hidden border border-zinc-800/60 mt-1.5">
                            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${val}%`, background: cor }}></div>
                          </div>
                          {pts && (
                            <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="w-full h-6 mt-1.5">
                              <polyline points={pts} fill="none" stroke={cor} strokeWidth="1.5" opacity="0.7" />
                            </svg>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {histMetricas.length > 1 && (
                  <div className="p-3 rounded-xl bg-zinc-900/40 border border-zinc-800/60">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Tendência (24h)</span>
                      <span className="text-[10px]"><span className="text-emerald-400">━ CPU</span><span className="text-blue-400 ml-2">━ RAM</span></span>
                    </div>
                    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="w-full h-24">
                      {[0, 15, 30].map((y) => <line key={y} x1="0" y1={y} x2="100" y2={y} stroke="#27272a" strokeWidth="0.3" />)}
                      <polyline points={histMetricas.map((a: any, i: number) => `${(i / (histMetricas.length - 1)) * 100},${30 - ((a.cpu || 0) / 100) * 30}`).join(" ")} fill="none" stroke="#34d399" strokeWidth="0.7" />
                      <polyline points={histMetricas.map((a: any, i: number) => `${(i / (histMetricas.length - 1)) * 100},${30 - ((a.ram || 0) / 100) * 30}`).join(" ")} fill="none" stroke="#60a5fa" strokeWidth="0.7" />
                    </svg>
                  </div>
                )}
                {carregandoInventario ? (
                  <div className="flex flex-col items-center justify-center py-24">
                    <span className="w-8 h-8 border-3 border-zinc-800 border-t-emerald-500 rounded-full animate-spin"></span>
                    <p className="text-zinc-500 text-xs mt-3">Carregando ficha técnica...</p>
                  </div>
                ) : !inventario ? (
                  <div className="text-center py-16 text-zinc-500 text-xs space-y-3 flex flex-col items-center">
                    <div className="w-12 h-12 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center">
                      <svg className="w-6 h-6 text-zinc-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
                      </svg>
                    </div>
                    <span>Nenhum inventário coletado para esta máquina.</span>
                    <p className="text-[10px] text-zinc-600 max-w-[240px] mx-auto">
                      Aguarde o agente RMM conectar e enviar as informações de hardware e software.
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Grid de Hardware e SO */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {/* SO */}
                      <div className="p-4 rounded-xl bg-zinc-900/40 border border-zinc-800/60 space-y-2">
                        <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block">Sistema Operacional</span>
                        <div className="font-semibold text-white text-xs leading-relaxed">{inventario.so.nome}</div>
                        <div className="text-[10px] text-zinc-400 space-y-0.5 font-mono">
                          <div>Versão: {inventario.so.versao}</div>
                          <div>Arq: {inventario.so.arquitetura}</div>
                          {inventario.so.bootTime && (
                            <div className="text-[9px] text-zinc-500 truncate" title={new Date(inventario.so.bootTime).toLocaleString()}>
                              Boot: {new Date(inventario.so.bootTime).toLocaleString()}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* CPU & RAM */}
                      <div className="p-4 rounded-xl bg-zinc-900/40 border border-zinc-800/60 space-y-2">
                        <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block">Hardware Principal</span>
                        <div className="font-semibold text-white text-xs truncate" title={inventario.hardware.cpu.modelo}>
                          {inventario.hardware.cpu.modelo}
                        </div>
                        <div className="text-[10px] text-zinc-400 space-y-0.5 font-mono">
                          <div>Núcleos: {inventario.hardware.cpu.cores} C / {inventario.hardware.cpu.threads} T</div>
                          <div>RAM: {(inventario.hardware.ram.totalBytes / (1024 * 1024 * 1024)).toFixed(1)} GB</div>
                          <div className="text-[9px] text-zinc-500 truncate">
                            Placa: {inventario.hardware.fabricante} {inventario.hardware.modeloPlaca}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Armazenamento (Discos) */}
                    <div className="p-4 rounded-xl bg-zinc-900/40 border border-zinc-800/60 space-y-3">
                      <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block">Armazenamento</span>
                      {(!inventario.hardware.discos || inventario.hardware.discos.length === 0) ? (
                        <div className="text-[11px] text-zinc-500">Nenhum disco lógico detectado</div>
                      ) : (
                        inventario.hardware.discos.map((d: any) => {
                          const totalGB = (d.tamanhoBytes / (1024 * 1024 * 1024)).toFixed(1);
                          const livreGB = (d.livreBytes / (1024 * 1024 * 1024)).toFixed(1);
                          const usadoBytes = d.tamanhoBytes - d.livreBytes;
                          const pctUsado = d.tamanhoBytes > 0 ? Math.round((usadoBytes / d.tamanhoBytes) * 100) : 0;
                          return (
                            <div key={d.caminho} className="space-y-1.5">
                              <div className="flex justify-between text-[11px] leading-none">
                                <span className="font-semibold text-zinc-300">Unidade {d.caminho}</span>
                                <span className="text-zinc-500 text-[10px] font-mono">
                                  {livreGB} GB livres de {totalGB} GB ({pctUsado}% usado)
                                </span>
                              </div>
                              <div className="w-full bg-zinc-950 h-2 rounded-full overflow-hidden border border-zinc-800/60">
                                <div
                                  className={`h-full rounded-full transition-all ${
                                    pctUsado > 90
                                      ? "bg-red-500 glow-red"
                                      : pctUsado > 75
                                      ? "bg-amber-500"
                                      : "bg-emerald-500 glow-emerald"
                                  }`}
                                  style={{ width: `${pctUsado}%` }}
                                ></div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>

                    {/* Interfaces de Rede */}
                    <div className="p-4 rounded-xl bg-zinc-900/40 border border-zinc-800/60 space-y-2">
                      <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block">Conexões de Rede</span>
                      <div className="space-y-2 max-h-[140px] overflow-y-auto pr-1">
                        {(!inventario.rede || inventario.rede.length === 0) ? (
                          <div className="text-[11px] text-zinc-500 font-mono">Nenhuma interface de rede encontrada</div>
                        ) : (
                          inventario.rede.map((r: any) => (
                            <div key={r.interface} className="p-2.5 rounded-lg bg-zinc-950/50 border border-zinc-900 text-xs space-y-1">
                              <div className="flex justify-between text-zinc-400">
                                <span className="font-semibold text-zinc-200 flex items-center gap-1">
                                  <svg className="w-3 h-3 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1" fill="currentColor"/></svg>
                                  {r.interface}
                                </span>
                                <span className="font-mono text-[10px] text-zinc-500">{r.mac}</span>
                              </div>
                              <div className="text-[10px] text-zinc-400 font-mono">
                                IPs: {r.ips.filter((ip: string) => !ip.includes(":")).join(", ") || r.ips.join(", ")}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    {/* Softwares Instalados */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Softwares Instalados</span>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-zinc-400 font-semibold bg-zinc-900 border border-zinc-800 px-2 py-0.5 rounded-md font-mono">
                            {((inventario.software || []).filter((s: any) =>
                              s.nome.toLowerCase().includes(filtroSoftware.toLowerCase()) ||
                              (s.fornecedor && s.fornecedor.toLowerCase().includes(filtroSoftware.toLowerCase()))
                            )).length} de {(inventario.software || []).length}
                          </span>
                          <button
                            onClick={() => executarCveScan(maquinaServicos.id)}
                            disabled={cveScanCarregando}
                            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[10px] font-bold hover:bg-amber-500/20 transition-all cursor-pointer disabled:opacity-50"
                          >
                            {cveScanCarregando ? (
                              <span className="w-3 h-3 border border-amber-400/30 border-t-amber-400 rounded-full animate-spin" />
                            ) : (
                              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                              </svg>
                            )}
                            {cveScanCarregando ? "Analisando…" : "Scan CVE"}
                          </button>
                        </div>
                      </div>

                      <input
                        type="text"
                        placeholder="Buscar software por nome ou fornecedor..."
                        value={filtroSoftware}
                        onChange={(e) => setFiltroSoftware(e.target.value)}
                        className="w-full px-4 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs focus:outline-none focus:border-emerald-500/40"
                      />

                      <div className="max-h-[260px] overflow-y-auto border border-zinc-850 rounded-xl divide-y divide-zinc-900/60 bg-zinc-950/20">
                        {(!inventario.software || inventario.software.length === 0) ? (
                          <div className="text-center py-8 text-zinc-500 text-xs font-mono">Nenhum software listado</div>
                        ) : (
                          (inventario.software || [])
                            .filter((s: any) =>
                              s.nome.toLowerCase().includes(filtroSoftware.toLowerCase()) ||
                              (s.fornecedor && s.fornecedor.toLowerCase().includes(filtroSoftware.toLowerCase()))
                            )
                            .map((s: any, idx: number) => (
                              <div key={idx} className="p-3 text-xs flex justify-between items-start gap-4 hover:bg-zinc-900/20 transition-colors">
                                <div className="min-w-0 flex-1">
                                  <div className="font-semibold text-zinc-100 truncate" title={s.nome}>{s.nome}</div>
                                  {s.fornecedor && <div className="text-[10px] text-zinc-500 truncate mt-0.5">{s.fornecedor}</div>}
                                </div>
                                <div className="shrink-0 text-right space-y-1 flex flex-col items-end">
                                  {s.versao && (
                                    <span className="inline-block px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-400 text-[9px] border border-zinc-800 font-mono">
                                      v{s.versao}
                                    </span>
                                  )}
                                  {s.dataInstalacao && (
                                    <div className="text-[9px] text-zinc-500 font-mono">{s.dataInstalacao}</div>
                                  )}
                                  <button
                                    onClick={() => desinstalarApp(s.nome)}
                                    disabled={desinstalando === s.nome}
                                    title="Desinstalar este programa (silencioso). Use se suspeitar de malware."
                                    className="mt-1 px-2 py-0.5 rounded bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-[9px] font-semibold text-red-300 cursor-pointer disabled:opacity-50"
                                  >
                                    {desinstalando === s.nome ? "desinstalando…" : "🗑 Desinstalar"}
                                  </button>
                                </div>
                              </div>
                            ))
                        )}
                      </div>
                    </div>

                    {/* Painel de resultados CVE */}
                    {cveResultado && (
                      <div className="space-y-3">
                        {/* Header do painel */}
                        <button
                          onClick={() => setCveExpandido((v) => !v)}
                          className="w-full flex items-center justify-between gap-2 cursor-pointer group"
                        >
                          <div className="flex items-center gap-2">
                            <svg className="w-3.5 h-3.5 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                            </svg>
                            <span className="text-[10px] font-bold text-amber-400 uppercase tracking-wider">Vulnerabilidades CVE</span>
                            {cveResultado.criticos > 0 && (
                              <span className="px-1.5 py-0.5 rounded-full bg-red-500/15 border border-red-500/30 text-[9px] font-bold text-red-400">{cveResultado.criticos} crítico{cveResultado.criticos !== 1 ? "s" : ""}</span>
                            )}
                            {cveResultado.altos > 0 && (
                              <span className="px-1.5 py-0.5 rounded-full bg-orange-500/15 border border-orange-500/30 text-[9px] font-bold text-orange-400">{cveResultado.altos} alto{cveResultado.altos !== 1 ? "s" : ""}</span>
                            )}
                            {cveResultado.total === 0 && (
                              <span className="px-1.5 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-[9px] font-bold text-emerald-400">Nenhum risco</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={(e) => { e.stopPropagation(); executarCveScan(maquinaServicos.id, true); }}
                              className="text-[9px] text-zinc-500 hover:text-zinc-300 transition-colors px-1"
                              title="Re-escanear"
                            >
                              ↺ Reanalisar
                            </button>
                            <svg className={`w-3 h-3 text-zinc-500 transition-transform ${cveExpandido ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><path d="M6 9l6 6 6-6"/></svg>
                          </div>
                        </button>

                        {cveExpandido && (
                          <div className="space-y-2">
                            {/* Resumo */}
                            <div className="px-3 py-2.5 rounded-xl bg-zinc-900/50 border border-zinc-800/60">
                              <p className="text-xs text-zinc-300 leading-relaxed">{cveResultado.resumo}</p>
                              <div className="flex items-center gap-3 mt-1.5">
                                <span className="text-[9px] text-zinc-600 font-mono">
                                  {new Date(cveResultado.geradoEm).toLocaleString("pt-BR")}
                                </span>
                                {cveResultado.semIA && <span className="text-[9px] text-zinc-600">análise heurística local</span>}
                                {cveResultado.cached && <span className="text-[9px] text-zinc-600">cache 6h</span>}
                              </div>
                            </div>

                            {/* Lista de vulnerabilidades */}
                            {cveResultado.vulnerabilidades.length === 0 ? (
                              <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-emerald-500/5 border border-emerald-500/20">
                                <svg className="w-4 h-4 text-emerald-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                                <p className="text-xs text-emerald-400">Nenhuma vulnerabilidade conhecida encontrada nos softwares instalados.</p>
                              </div>
                            ) : (
                              <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1">
                                {cveResultado.vulnerabilidades.map((v, i) => {
                                  const riscoMap: Record<string, { bg: string; border: string; text: string; label: string }> = {
                                    critico: { bg: "bg-red-500/8",    border: "border-red-500/25",    text: "text-red-400",    label: "CRÍTICO" },
                                    alto:    { bg: "bg-orange-500/8", border: "border-orange-500/25", text: "text-orange-400", label: "ALTO" },
                                    medio:   { bg: "bg-amber-500/8",  border: "border-amber-500/25",  text: "text-amber-400",  label: "MÉDIO" },
                                    baixo:   { bg: "bg-zinc-800/50",  border: "border-zinc-700/50",   text: "text-zinc-400",   label: "BAIXO" },
                                  };
                                  const rc = riscoMap[v.risco] ?? riscoMap.baixo;
                                  return (
                                    <div key={i} className={`rounded-xl p-3 border ${rc!.bg} ${rc!.border} space-y-1.5`}>
                                      <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                          <div className="flex items-center gap-2 flex-wrap">
                                            <span className="text-xs font-bold text-zinc-100 truncate">{v.software}</span>
                                            {v.versao && v.versao !== "desconhecida" && (
                                              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400">v{v.versao}</span>
                                            )}
                                          </div>
                                          <p className="text-[10px] text-zinc-400 mt-0.5 leading-relaxed">{v.descricao}</p>
                                        </div>
                                        <span className={`shrink-0 px-2 py-0.5 rounded-full text-[9px] font-bold border ${rc!.bg} ${rc!.border} ${rc!.text}`}>{rc!.label}</span>
                                      </div>
                                      {v.cve && (
                                        <a
                                          href={`https://nvd.nist.gov/vuln/detail/${v.cve}`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="inline-flex items-center gap-1 text-[9px] font-mono text-violet-400 hover:text-violet-300 transition-colors"
                                        >
                                          🔗 {v.cve}
                                        </a>
                                      )}
                                      <div className="flex items-start gap-1.5 pt-0.5">
                                        <svg className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                                        <p className="text-[10px] text-emerald-300/80 leading-relaxed">{v.recomendacao}</p>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : abaAtiva === "terminal" ? (
              /* ABA TERMINAL DE COMANDOS INTERATIVO — redesign Canvas */
              <div className={terminalFull ? "fixed inset-0 z-[120] flex flex-col bg-zinc-950" : "flex-1 flex flex-col min-h-0 bg-zinc-950/40"}>

                {/* ── Header da aba terminal ── */}
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800/60 shrink-0">
                  <div className="flex items-center gap-2.5">
                    {/* ícone >_ */}
                    <div className="w-6 h-6 rounded-md bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 text-[10px] font-mono font-bold shrink-0">
                      &gt;_
                    </div>
                    <div>
                      <span className="text-[11px] font-bold text-zinc-200 tracking-tight">Terminal</span>
                      {terminalStatus === "connected" && (
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                          <span className="text-[9px] font-semibold text-emerald-400 uppercase tracking-wider">{activeShellType} · Ativo</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {terminalStatus === "connected" && (
                      <button
                        onClick={pararTerminal}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-red-500/8 hover:bg-red-500/15 border border-red-500/25 text-[10px] font-semibold text-red-400 transition-all duration-200 cursor-pointer"
                      >
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                        Desconectar
                      </button>
                    )}
                    <button
                      onClick={() => setTerminalFull((v) => !v)}
                      title={terminalFull ? "Sair da tela cheia" : "Tela cheia"}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 border border-zinc-700/60 text-[10px] font-semibold text-zinc-300 transition-all cursor-pointer"
                    >
                      {terminalFull ? (
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>
                      ) : (
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M3 8V5a2 2 0 0 1 2-2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/></svg>
                      )}
                      {terminalFull ? "Restaurar" : "Tela cheia"}
                    </button>
                  </div>
                </div>

                {/* ── Estado: Disconnected ── */}
                {terminalStatus === "disconnected" && (
                  <div className="flex-1 flex flex-col justify-center items-center p-8">
                    <div className="w-full max-w-sm">
                      {/* Card central */}
                      <div className="text-center mb-7">
                        <div className="w-14 h-14 rounded-2xl bg-emerald-500/8 border border-emerald-500/20 flex items-center justify-center mx-auto mb-5 shadow-[0_0_32px_rgba(16,185,129,0.08)]">
                          <svg className="w-6 h-6 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
                          </svg>
                        </div>
                        <h3 className="text-sm font-bold text-zinc-100 tracking-tight">Iniciar Sessão Remota</h3>
                        <p className="text-[11px] text-zinc-500 mt-1.5 leading-relaxed">Terminal interativo SSH-like · ConPTY · auditado</p>
                      </div>

                      {!maquinaServicos?.online ? (
                        <div className="w-full px-4 py-3.5 rounded-xl bg-red-500/8 border border-red-500/20 flex items-center gap-3">
                          <svg className="w-4 h-4 text-red-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                          <p className="text-xs text-red-300">Máquina offline. Ligue-a para acessar o terminal.</p>
                        </div>
                      ) : user?.papel === "viewer" ? (
                        <div className="w-full px-4 py-3.5 rounded-xl bg-amber-500/8 border border-amber-500/20 flex items-center gap-3">
                          <svg className="w-4 h-4 text-amber-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                          <p className="text-xs text-amber-300">Visualizadores não têm permissão para executar comandos.</p>
                        </div>
                      ) : (
                        <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-5 space-y-4">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0">
                              <svg className="w-4 h-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M8 10l4 4 4-4"/></svg>
                            </div>
                            <div>
                              <p className="text-xs font-bold text-zinc-200">PowerShell</p>
                              <p className="text-[10px] text-zinc-500 mt-0.5">Edição de linha, histórico, ConPTY</p>
                            </div>
                          </div>
                          <button
                            onClick={() => iniciarTerminal("powershell")}
                            className="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 active:scale-[0.98] text-xs font-bold text-zinc-950 transition-all duration-200 shadow-[0_0_20px_rgba(16,185,129,0.25)] hover:shadow-[0_0_28px_rgba(16,185,129,0.4)] cursor-pointer"
                          >
                            Conectar PowerShell
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* ── Estado: Connecting ── */}
                {terminalStatus === "connecting" && (
                  <div className="flex-1 flex flex-col justify-center items-center gap-4">
                    <div className="w-10 h-10 rounded-full border-2 border-zinc-800 border-t-emerald-500 animate-spin"></div>
                    <div className="text-center">
                      <p className="text-xs font-semibold text-zinc-300">Estabelecendo túnel seguro</p>
                      <p className="text-[10px] text-zinc-600 mt-1">Conectando ao agente via ConPTY...</p>
                    </div>
                  </div>
                )}

                {/* ── Estado: Connected — layout 2 colunas ── */}
                {terminalStatus === "connected" && (
                  <div className="flex-1 flex flex-col md:flex-row min-h-0 overflow-hidden">

                    {/* Coluna terminal — flex-1 */}
                    <div className="flex-1 min-w-0 flex flex-col p-3 gap-0 min-h-0">
                      <div
                        className="flex-1 relative"
                        style={{ minHeight: "220px" }}
                      >
                        <div
                          ref={terminalContainerRef}
                          className="absolute inset-0 bg-zinc-950 rounded-xl border border-zinc-800/60 overflow-hidden shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)] focus-within:border-emerald-500/20 transition-colors"
                        />
                      </div>
                    </div>

                    {/* Separador vertical (apenas md+) */}
                    {copilotAtivo && (
                      <div className="hidden md:block w-px bg-zinc-800/40 shrink-0 my-3" />
                    )}

                    {/* Coluna Copilot — colapsável */}
                    {copilotAtivo ? (
                      <div className="md:w-72 shrink-0 flex flex-col bg-zinc-900/40 border-t border-zinc-800/60 md:border-t-0 md:border-l-0 max-h-48 md:max-h-none overflow-y-auto md:overflow-visible">
                        {/* Header copilot */}
                        <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800/60 shrink-0">
                          <div className="flex items-center gap-2">
                            <svg className="w-3.5 h-3.5 text-violet-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 2a10 10 0 1 0 10 10H12V2z"/><path d="M12 2a10 10 0 0 1 10 10"/><circle cx="12" cy="12" r="1"/>
                            </svg>
                            <span className="text-[10px] font-bold text-zinc-300 uppercase tracking-wider">Copilot IA</span>
                          </div>
                          <button
                            onClick={() => { setCopilotAtivo((v) => !v); setCopilotPreview(null); setCopilotInput(""); }}
                            className="w-5 h-5 flex items-center justify-center rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                            title="Fechar Copilot"
                          >
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                          </button>
                        </div>

                        {/* Corpo copilot */}
                        <div className="flex-1 p-4 space-y-3 overflow-y-auto">
                          <p className="text-[10px] text-zinc-600 leading-relaxed">Descreva em português — a IA traduz para PowerShell.</p>

                          {/* Input */}
                          <div className="flex gap-1.5">
                            <input
                              type="text"
                              value={copilotInput}
                              onChange={e => setCopilotInput(e.target.value)}
                              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); traduzirCopilot(); } }}
                              placeholder="Descreva o que quer fazer…"
                              className="flex-1 min-w-0 px-3 py-1.5 rounded-lg bg-zinc-950/60 border border-zinc-700/60 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-colors"
                            />
                            <button
                              onClick={traduzirCopilot}
                              disabled={copilotCarregando || !copilotInput.trim()}
                              className="px-2.5 py-1.5 rounded-lg bg-violet-500/15 border border-violet-500/30 text-xs font-bold text-violet-300 hover:bg-violet-500/25 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors shrink-0"
                            >
                              {copilotCarregando ? (
                                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                              ) : (
                                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                              )}
                            </button>
                          </div>

                          {/* Preview do comando */}
                          {copilotPreview && copilotPreview.comando && (
                            <div className="rounded-lg border border-emerald-500/15 bg-emerald-500/5 overflow-hidden">
                              <div className="px-3 py-2 border-b border-emerald-500/10">
                                <p className="text-[9px] font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Comando gerado</p>
                                <code className="text-[11px] font-mono text-emerald-300 break-all leading-relaxed">{copilotPreview.comando}</code>
                              </div>
                              {copilotPreview.explicacao && (
                                <div className="px-3 py-2">
                                  <p className="text-[10px] text-zinc-500 leading-relaxed">{copilotPreview.explicacao}</p>
                                </div>
                              )}
                              <div className="flex gap-2 px-3 py-2 bg-zinc-950/30">
                                <button
                                  onClick={() => setCopilotPreview(null)}
                                  className="flex-1 py-1.5 rounded-lg bg-zinc-800/80 border border-zinc-700/60 text-[10px] font-semibold text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/80 transition-colors cursor-pointer"
                                >
                                  Cancelar
                                </button>
                                <button
                                  onClick={executarCopilot}
                                  className="flex-1 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 active:scale-95 text-[10px] font-bold text-zinc-950 transition-all cursor-pointer shadow-[0_0_12px_rgba(16,185,129,0.2)]"
                                >
                                  Executar
                                </button>
                              </div>
                            </div>
                          )}

                          {copilotPreview && !copilotPreview.comando && (
                            <p className="text-[10px] text-zinc-500 leading-relaxed">{copilotPreview.explicacao}</p>
                          )}
                        </div>
                      </div>
                    ) : (
                      /* Aba vertical de toggle do Copilot (quando fechado) */
                      <div className="hidden md:flex items-center justify-center w-8 shrink-0 border-l border-zinc-800/40">
                        <button
                          onClick={() => setCopilotAtivo((v) => !v)}
                          title="Abrir Copilot IA"
                          className="flex flex-col items-center gap-1.5 py-3 px-1 rounded-lg hover:bg-zinc-800/60 text-zinc-600 hover:text-violet-400 transition-colors cursor-pointer group"
                        >
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 2a10 10 0 1 0 10 10H12V2z"/><path d="M12 2a10 10 0 0 1 10 10"/><circle cx="12" cy="12" r="1"/>
                          </svg>
                          <span className="text-[8px] font-bold uppercase tracking-widest" style={{ writingMode: "vertical-rl", textOrientation: "mixed", transform: "rotate(180deg)" }}>Copilot</span>
                        </button>
                      </div>
                    )}

                    {/* Toggle Copilot mobile (abaixo do terminal) */}
                    {!copilotAtivo && (
                      <div className="md:hidden flex items-center justify-center px-3 py-2 border-t border-zinc-800/40">
                        <button
                          onClick={() => setCopilotAtivo((v) => !v)}
                          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-[10px] font-semibold text-zinc-400 hover:text-violet-300 hover:border-violet-500/30 transition-colors cursor-pointer"
                        >
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 2a10 10 0 1 0 10 10H12V2z"/><path d="M12 2a10 10 0 0 1 10 10"/><circle cx="12" cy="12" r="1"/>
                          </svg>
                          Abrir Copilot IA
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : abaAtiva === "arquivos" ? (
              /* ABA DE ARQUIVOS */
              <div className="flex-1 flex flex-col p-6 gap-3 min-h-0">
                <div className="flex items-center gap-2">
                  <button onClick={voltarPasta} disabled={!caminhoArq} className="px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-300 disabled:opacity-40 cursor-pointer">⬅</button>
                  <span className="text-xs font-mono text-zinc-400 truncate flex-1 px-2 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800/60">{caminhoArq || "Meu Computador"}</span>
                  <button onClick={() => listarArquivos(caminhoArq)} title="Atualizar" className="px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-300 cursor-pointer">↻</button>
                  <label className="px-3 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-xs font-semibold text-emerald-300 cursor-pointer">
                    ⬆ Enviar
                    <input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) enviarArquivo(f); e.currentTarget.value = ""; }} />
                  </label>
                </div>
                <div className="flex-1 overflow-y-auto border border-zinc-800 rounded-xl divide-y divide-zinc-900/60 bg-zinc-950/20">
                  {carregandoArq ? (
                    <div className="flex items-center justify-center py-12"><span className="w-6 h-6 border-2 border-zinc-800 border-t-emerald-500 rounded-full animate-spin"></span></div>
                  ) : arquivosItens.length === 0 ? (
                    <div className="text-center py-12 text-xs text-zinc-500">Pasta vazia ou sem acesso.</div>
                  ) : (
                    arquivosItens.map((it: any, i: number) => (
                      <div key={i} className="flex items-center justify-between px-3 py-2 hover:bg-zinc-900/30 text-xs">
                        <button onClick={() => { if (it.dir) entrarPasta(it.Name); }} className={`flex items-center gap-2 min-w-0 ${it.dir ? "cursor-pointer text-zinc-100" : "text-zinc-400 cursor-default"}`}>
                          <span className="shrink-0">{it.dir ? "📁" : "📄"}</span>
                          <span className="truncate">{it.Name}</span>
                        </button>
                        <div className="flex items-center gap-3 shrink-0">
                          {!it.dir && <span className="text-[10px] text-zinc-600 font-mono">{((it.tamanho || 0) / 1024).toFixed(0)} KB</span>}
                          {!it.dir && <button onClick={() => baixarArquivo(it.Name)} className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-[10px] font-semibold text-emerald-300 hover:bg-zinc-800 cursor-pointer">⬇ Baixar</button>}
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <p className="text-[10px] text-zinc-500">Limite 10MB por arquivo · tudo auditado · a máquina precisa estar online.</p>
              </div>
            ) : abaAtiva === "manutencao" ? (
              <div className="flex-1 overflow-y-auto p-6 space-y-5">
                <div className="glass-panel rounded-2xl p-4 border border-zinc-800 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                  <div><div className="text-[10px] text-zinc-500">Máquina</div><div className="text-zinc-200">{maquinaServicos.apelido || maquinaServicos.hostname}</div></div>
                  <div>
                    <div className="text-[10px] text-zinc-500">👤 Responsável (quem usa/cuida)</div>
                    <div className="flex gap-1.5 mt-0.5"><input value={respEdit} onChange={(e) => setRespEdit(e.target.value)} placeholder="nome do responsável" className="flex-1 px-2 py-1 rounded bg-zinc-900 border border-zinc-800 text-xs text-zinc-200" /><button onClick={salvarResponsavel} className="px-2.5 py-1 rounded bg-emerald-500/15 border border-emerald-500/30 text-[10px] text-emerald-300 cursor-pointer">Salvar</button></div>
                  </div>
                </div>

                <div className="glass-panel rounded-2xl p-4 border border-zinc-800 space-y-2">
                  <h4 className="text-sm font-bold text-white">➕ Registrar manutenção</h4>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    <select value={novaManut.tipo} onChange={(e) => setNovaManut({ ...novaManut, tipo: e.target.value })} className="px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 cursor-pointer">
                      <option value="corretiva">🔴 Corretiva</option><option value="preventiva">🟢 Preventiva</option><option value="melhoria">⬆️ Melhoria</option><option value="instalacao">📦 Instalação</option>
                    </select>
                    <input value={novaManut.tecnico} onChange={(e) => setNovaManut({ ...novaManut, tecnico: e.target.value })} placeholder="Técnico" className="px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200" />
                    <input value={novaManut.custo} onChange={(e) => setNovaManut({ ...novaManut, custo: e.target.value })} placeholder="Custo (R$)" className="px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200" />
                    <div><label className="block text-[9px] text-zinc-500">Próx. preventiva</label><input type="date" value={novaManut.proximaPreventiva} onChange={(e) => setNovaManut({ ...novaManut, proximaPreventiva: e.target.value })} className="w-full px-2 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200" /></div>
                  </div>
                  <textarea value={novaManut.descricao} onChange={(e) => setNovaManut({ ...novaManut, descricao: e.target.value })} placeholder="O que foi feito / motivo da manutenção…" rows={2} className="w-full px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 resize-none" />
                  <input value={novaManut.pecasTrocadas} onChange={(e) => setNovaManut({ ...novaManut, pecasTrocadas: e.target.value })} placeholder="Peças trocadas (ex.: SSD 480GB, fonte 500W, memória 8GB)" className="w-full px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200" />
                  <button onClick={salvarManutencao} className="px-4 py-2 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-xs font-bold text-emerald-300 cursor-pointer">Salvar manutenção (exige MFA)</button>
                </div>

                {/* I) Audit Trail — linha do tempo de ações */}
                <div className="glass-panel rounded-2xl p-4 border border-zinc-800">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-bold text-white">🕵️ Linha do Tempo de Ações</h4>
                    <button onClick={() => carregarAuditTrail(maquinaServicos.id)} className="text-[10px] text-zinc-500 hover:text-zinc-300 cursor-pointer">↺ atualizar</button>
                  </div>
                  {carregandoAuditTrail ? <p className="text-xs text-zinc-500">Carregando…</p> :
                  !auditTrail || auditTrail.eventos.length === 0 ? <p className="text-xs text-zinc-500">Nenhuma ação registrada nos últimos eventos.</p> :
                  <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                    {auditTrail.eventos.map((ev: any, i: number) => (
                      <div key={i} className="flex items-start gap-2 text-[11px] py-1 border-b border-zinc-800/40 last:border-0">
                        <span className={`mt-0.5 shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded ${ev.tipo === "servico" ? "bg-blue-500/15 text-blue-300" : ev.ok ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>
                          {ev.tipo === "servico" ? "SVC" : ev.ok ? "ON" : "OFF"}
                        </span>
                        <div className="flex-1 min-w-0">
                          <span className={ev.ok ? "text-zinc-300" : "text-zinc-400"}>{ev.descricao}</span>
                        </div>
                        <span className="text-zinc-600 text-[10px] shrink-0">{new Date(ev.em).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                      </div>
                    ))}
                  </div>}
                </div>

                <div>
                  <h4 className="text-sm font-bold text-white mb-2 flex items-center gap-2">
                    <svg className="w-3.5 h-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                    </svg>
                    Histórico
                  </h4>
                  {!manutList ? <p className="text-xs text-zinc-500">Carregando…</p> :
                  manutList.length === 0 ? <p className="text-xs text-zinc-500">Nenhuma manutenção registrada ainda.</p> :
                  <div className="space-y-2">
                    {manutList.map((m) => {
                      const cor = m.tipo === "preventiva" ? "text-emerald-400" : m.tipo === "corretiva" ? "text-red-400" : "text-cyan-400";
                      return (
                        <div key={m.id} className="p-3 rounded-xl bg-zinc-900/40 border border-zinc-800/60">
                          <div className="flex justify-between items-start gap-2">
                            <div className="min-w-0">
                              <span className={`text-xs font-bold ${cor}`}>{String(m.tipo).toUpperCase()}</span>
                              <span className="text-[10px] text-zinc-500 ml-2">{new Date(m.dataManutencao).toLocaleDateString()}</span>
                              {m.tecnico && <span className="text-[10px] text-zinc-500 ml-2">· 👤 {m.tecnico}</span>}
                              {m.custo && <span className="text-[10px] text-amber-400/80 ml-2">· R$ {m.custo}</span>}
                              <p className="text-xs text-zinc-200 mt-1">{m.descricao}</p>
                              {m.pecasTrocadas && <p className="text-[11px] text-zinc-400 mt-0.5">🔩 {m.pecasTrocadas}</p>}
                              {m.proximaPreventiva && <p className="text-[11px] text-emerald-400/80 mt-0.5">📅 Próxima preventiva: {new Date(m.proximaPreventiva).toLocaleDateString()}</p>}
                              <div className="flex flex-wrap items-center gap-2 mt-2">
                                {(m.anexos || []).map((ax: any) => (ax.tipo || "").startsWith("image/") ? (
                                  <a key={ax.id} href={`/api/manutencoes/anexo/${ax.id}`} target="_blank" rel="noreferrer" className="relative group">
                                    <img src={`/api/manutencoes/anexo/${ax.id}`} alt={ax.nome} className="w-14 h-14 object-cover rounded-lg border border-zinc-700" />
                                    <button onClick={(e) => { e.preventDefault(); excluirAnexoManut(ax.id); }} className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-4 h-4 text-[10px] hidden group-hover:flex items-center justify-center">×</button>
                                  </a>
                                ) : (
                                  <span key={ax.id} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-zinc-900 border border-zinc-700 text-[10px] text-zinc-300">
                                    <a href={`/api/manutencoes/anexo/${ax.id}`} target="_blank" rel="noreferrer" className="hover:text-emerald-300">📄 {ax.nome}</a>
                                    <button onClick={() => excluirAnexoManut(ax.id)} className="text-zinc-500 hover:text-red-400">×</button>
                                  </span>
                                ))}
                                <label className="px-2 py-1 rounded-lg bg-zinc-900 border border-dashed border-zinc-700 text-[10px] text-zinc-400 hover:text-emerald-300 cursor-pointer">
                                  📎 Anexar foto/NF
                                  <input type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) enviarAnexoManut(m.id, f); e.currentTarget.value = ""; }} />
                                </label>
                              </div>
                            </div>
                            <button onClick={() => excluirManutencao(m.id)} title="Excluir" className="text-zinc-600 hover:text-red-400 text-sm cursor-pointer shrink-0">🗑</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>}
                </div>
              </div>
            ) : (
              /* ABA DE LOGS DE AUDITORIA */
              <div className="flex-1 overflow-y-auto p-6 space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block">Auditoria Criptográfica</span>
                    <p className="text-[10px] text-zinc-500 mt-0.5 font-mono">Cadeia de hash gerada e mantida de forma imutável pelo banco de dados.</p>
                  </div>
                  {logs.length > 0 && (
                    <button
                      onClick={exportarCsv}
                      className="px-3 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-[10px] font-semibold text-emerald-300 transition-colors cursor-pointer"
                    >
                      📥 Exportar CSV
                    </button>
                  )}
                </div>

                <div className="flex gap-2">
                  <select
                    value={filtroLogsStatus}
                    onChange={(e) => setFiltroLogsStatus(e.target.value)}
                    className="w-full px-4 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs focus:outline-none focus:border-emerald-500/40 cursor-pointer"
                  >
                    <option value="">Todos os status</option>
                    <option value="SUCESSO">Sucesso</option>
                    <option value="FALHA">Falha</option>
                  </select>
                </div>

                {carregandoLogs ? (
                  <div className="flex flex-col items-center justify-center py-24">
                    <span className="w-8 h-8 border-3 border-zinc-800 border-t-emerald-500 rounded-full animate-spin"></span>
                    <p className="text-zinc-500 text-xs mt-3">Carregando logs de auditoria...</p>
                  </div>
                ) : logs.length === 0 ? (
                  <div className="text-center py-16 text-zinc-500 text-xs font-mono">
                    Nenhuma ação registrada nesta máquina.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {logs
                      .filter((l: any) => filtroLogsStatus === "" || l.statusResultado === filtroLogsStatus)
                      .map((l: any) => (
                        <div
                          key={l.id}
                          className="p-4 rounded-xl bg-zinc-900/40 border border-zinc-800/60 hover:bg-zinc-900/60 transition-colors space-y-2"
                        >
                          <div className="flex justify-between items-start">
                            <div>
                              <span className="inline-block px-1.5 py-0.5 rounded bg-zinc-950 text-zinc-300 text-[10px] font-mono border border-zinc-850">
                                {l.servicoNome}
                              </span>
                              <span className="text-zinc-400 text-xs font-semibold ml-2">{l.acaoExecutada}</span>
                            </div>
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[9px] font-semibold border ${
                                l.statusResultado === "SUCESSO"
                                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                  : "bg-red-500/10 text-red-400 border-red-500/20"
                              }`}
                            >
                              {l.statusResultado === "SUCESSO" ? "✓ Sucesso" : "✗ Falha"}
                            </span>
                          </div>

                          <div className="text-[10px] text-zinc-400 space-y-0.5 font-mono">
                            <div>Executor: {l.usuarioEmail || "Sistema / API"}</div>
                            <div>Data: {new Date(l.executadoEm).toLocaleString()}</div>
                            {l.detalhesErro && <div className="text-red-400/80 mt-1">Erro: {l.detalhesErro}</div>}
                          </div>

                          {l.hashRegistro && (
                            <div className="pt-2 border-t border-zinc-900 flex items-center justify-between">
                              <span className="text-[9px] font-semibold text-emerald-500/80 flex items-center gap-1">
                                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full glow-emerald"></span>
                                Criptografia Íntegra
                              </span>
                              <span
                                className="font-mono text-[8px] text-zinc-600 truncate max-w-[200px]"
                                title={`Hash do registro: ${l.hashRegistro}`}
                              >
                                {l.hashRegistro}
                              </span>
                            </div>
                          )}
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* ═══════════════════════ DOCUMENTAÇÃO ═══════════════════════ */}
      {secao === "docs" && (
        <main className="flex-1 max-w-[900px] w-full mx-auto p-4 md:p-8 space-y-8">

          {/* Intro */}
          <div className="glass-panel rounded-2xl p-6 border border-emerald-500/20 bg-gradient-to-br from-emerald-500/5 to-transparent">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-xl">📘</div>
              <div>
                <h2 className="text-base font-bold text-white">Documentação do Nexus RMM</h2>
                <p className="text-[11px] text-zinc-500">Tudo que você precisa para instalar, configurar e usar o produto.</p>
              </div>
            </div>
          </div>

          {/* ── 1. Instalar agente ── */}
          <div className="glass-panel rounded-2xl p-6 border border-zinc-800 space-y-4">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">🖥️ Instalar o Agente</h3>
            <p className="text-xs text-zinc-400">O agente é um processo leve que roda em segundo plano, conecta ao servidor via mTLS e envia métricas. Gere o token em <b>Máquinas → Cadastrar Nova Máquina</b>.</p>

            {/* Windows */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-base">🪟</span>
                <h4 className="text-xs font-bold text-zinc-200">Windows</h4>
                <span className="px-2 py-0.5 rounded-full text-[9px] bg-emerald-500/15 text-emerald-300 font-bold">Recomendado</span>
              </div>
              <p className="text-[11px] text-zinc-500">Abra o PowerShell como Administrador e cole o comando abaixo (substitua pelo token do painel):</p>
              <div className="bg-zinc-950 rounded-xl p-3 border border-zinc-800 font-mono text-[11px] text-emerald-300 overflow-x-auto">
                <span className="text-zinc-500"># Cole no PowerShell (Administrador)</span><br/>
                Instalar-Nexus -Token "SEU_TOKEN_AQUI"<br/>
                <span className="text-zinc-600"># Ou o comando completo:</span><br/>
                iex ((New-Object System.Net.WebClient).DownloadString({`'`}https://rmm.gmtec.tec.br/instalar.ps1{`'`})); Instalar-Nexus -Token "SEU_TOKEN_AQUI"
              </div>
              <p className="text-[10px] text-zinc-600">O instalador baixa Node.js 24 dedicado, instala como serviço do Windows (auto-start, reinicia se cair) e registra a máquina automaticamente.</p>
            </div>

            <div className="h-px bg-zinc-800/60" />

            {/* Linux */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-base">🐧</span>
                <h4 className="text-xs font-bold text-zinc-200">Linux</h4>
                <span className="px-2 py-0.5 rounded-full text-[9px] bg-blue-500/15 text-blue-300 font-bold">Ubuntu · Debian · RHEL · Fedora · Arch</span>
              </div>
              <p className="text-[11px] text-zinc-500">Execute como root (ou com sudo):</p>
              <div className="bg-zinc-950 rounded-xl p-3 border border-zinc-800 font-mono text-[11px] text-emerald-300 overflow-x-auto">
                curl -sSL https://rmm.gmtec.tec.br/instalar-linux.sh | sudo bash -s -- --token=SEU_TOKEN_AQUI
              </div>
              <p className="text-[10px] text-zinc-600">Instala Node.js via NodeSource (se necessário), baixa o agente e cria o serviço <code>nexus-agente</code> via systemd. Logs: <code>journalctl -u nexus-agente -f</code></p>
              <div className="text-[10px] text-zinc-600 space-y-0.5">
                <p><b className="text-zinc-400">Parar:</b> <code>sudo systemctl stop nexus-agente</code></p>
                <p><b className="text-zinc-400">Desinstalar:</b> <code>sudo systemctl disable --now nexus-agente && sudo rm /etc/systemd/system/nexus-agente.service && sudo rm -rf /opt/nexus-rmm</code></p>
              </div>
            </div>

            <div className="h-px bg-zinc-800/60" />

            {/* macOS */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-base">🍎</span>
                <h4 className="text-xs font-bold text-zinc-200">macOS</h4>
                <span className="px-2 py-0.5 rounded-full text-[9px] bg-zinc-600/40 text-zinc-400 font-bold">Monterey 12+ · Intel e Apple Silicon</span>
              </div>
              <p className="text-[11px] text-zinc-500">Execute no Terminal como root:</p>
              <div className="bg-zinc-950 rounded-xl p-3 border border-zinc-800 font-mono text-[11px] text-emerald-300 overflow-x-auto">
                curl -sSL https://rmm.gmtec.tec.br/instalar-macos.sh | sudo bash -s -- --token=SEU_TOKEN_AQUI
              </div>
              <p className="text-[10px] text-zinc-600">Usa Homebrew (se disponível) ou baixa Node.js oficial. Instala como LaunchDaemon (root, auto-start). Logs: <code>tail -f /var/log/nexus-agente.log</code></p>
              <div className="text-[10px] text-zinc-600 space-y-0.5">
                <p><b className="text-zinc-400">Parar:</b> <code>sudo launchctl unload /Library/LaunchDaemons/br.com.nexus-rmm.agente.plist</code></p>
                <p><b className="text-zinc-400">Desinstalar:</b> <code>sudo launchctl unload ... && sudo rm /Library/LaunchDaemons/br.com.nexus-rmm.agente.plist && sudo rm -rf /opt/nexus-rmm</code></p>
              </div>
            </div>

            <div className="h-px bg-zinc-800/60" />

            {/* Android */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-base">📱</span>
                <h4 className="text-xs font-bold text-zinc-200">Android / iOS — App Móvel (PWA)</h4>
              </div>
              <p className="text-[11px] text-zinc-500">O Nexus RMM funciona como app instalável no celular — sem precisar de loja de aplicativos:</p>
              <div className="space-y-2 text-xs text-zinc-400">
                <div className="flex items-start gap-2">
                  <span className="text-emerald-400 shrink-0 mt-0.5">1.</span>
                  <span>Abra <b className="text-white">rmm.gmtec.tec.br</b> no Chrome (Android) ou Safari (iOS)</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-emerald-400 shrink-0 mt-0.5">2.</span>
                  <span>No Chrome: toque nos 3 pontos → <b className="text-white">Adicionar à tela inicial</b></span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-emerald-400 shrink-0 mt-0.5">3.</span>
                  <span>No Safari (iOS): toque em <b className="text-white">Compartilhar → Adicionar à Tela de Início</b></span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-emerald-400 shrink-0 mt-0.5">4.</span>
                  <span>O app abre em tela cheia, sem barra do navegador, igual a um app nativo</span>
                </div>
              </div>
              <p className="text-[10px] text-zinc-600">Perfeito para aprovar remediações IA, verificar alertas e acompanhar máquinas offline onde quer que esteja.</p>
            </div>
          </div>

          {/* ── 2. Alertas Telegram ── */}
          <div className="glass-panel rounded-2xl p-6 border border-zinc-800 space-y-4">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">✈️ Configurar Alertas via Telegram</h3>
            <p className="text-xs text-zinc-400">Receba alertas de CPU, RAM, disco e máquinas offline diretamente no Telegram, e aprove remediações IA respondendo uma mensagem.</p>

            <div className="space-y-3 text-xs text-zinc-400">
              <div className="flex gap-3">
                <span className="w-6 h-6 rounded-full bg-blue-500/15 border border-blue-500/20 flex items-center justify-center text-[10px] font-bold text-blue-300 shrink-0">1</span>
                <div><b className="text-white">Criar o bot:</b> Abra o Telegram e converse com <code className="bg-zinc-900 px-1 rounded">@BotFather</code>. Digite <code>/newbot</code>, dê um nome e obtenha o <b>Token do Bot</b> (formato <code>123456:ABC-DEF...</code>).</div>
              </div>
              <div className="flex gap-3">
                <span className="w-6 h-6 rounded-full bg-blue-500/15 border border-blue-500/20 flex items-center justify-center text-[10px] font-bold text-blue-300 shrink-0">2</span>
                <div><b className="text-white">Obter o Chat ID:</b> Adicione o bot a um grupo ou converse diretamente. Envie qualquer mensagem e acesse <code className="bg-zinc-900 px-1 rounded">https://api.telegram.org/botSEU_TOKEN/getUpdates</code> para ver o <code>chat.id</code>.</div>
              </div>
              <div className="flex gap-3">
                <span className="w-6 h-6 rounded-full bg-blue-500/15 border border-blue-500/20 flex items-center justify-center text-[10px] font-bold text-blue-300 shrink-0">3</span>
                <div><b className="text-white">Configurar no painel:</b> Vá em <b>Usuários → Alertas Telegram</b>, cole o token e o chat ID, salve e clique em <b>Enviar teste</b>.</div>
              </div>
              <div className="flex gap-3">
                <span className="w-6 h-6 rounded-full bg-blue-500/15 border border-blue-500/20 flex items-center justify-center text-[10px] font-bold text-blue-300 shrink-0">4</span>
                <div><b className="text-white">Registrar webhook (aprovações IA):</b> Clique em <b>📡 Registrar webhook (aprovações)</b>. Isso configura o Telegram para enviar respostas ao Nexus automaticamente — necessário para aprovar remediações via chat.</div>
              </div>
            </div>

            <div className="bg-zinc-950 rounded-xl p-3 border border-zinc-800 text-[11px] text-zinc-400 space-y-1">
              <p className="text-zinc-300 font-semibold">Como aprovar uma remediação pelo Telegram:</p>
              <p>Quando a IA detectar um problema, você receberá uma mensagem como:</p>
              <div className="bg-zinc-900 rounded-lg p-2 text-[10px] font-mono text-amber-300 mt-1">
                ⚠️ Nexus RMM — Aprovação Necessária<br/>
                Máquina: Servidor-01<br/>
                Problema: CPU 95% por 3 min...<br/>
                IA propõe: Limpar temporários<br/>
                Responda SIM ABC123 para autorizar<br/>
                Responda NÃO ABC123 para cancelar<br/>
                ⏰ Expira em 10 minutos
              </div>
              <p className="mt-1">Responda <code>SIM ABC123</code> para autorizar ou <code>NÃO ABC123</code> para cancelar.</p>
            </div>
          </div>

          {/* ── 3. Alertas WhatsApp ── */}
          <div className="glass-panel rounded-2xl p-6 border border-zinc-800 space-y-4">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">💬 Configurar Alertas via WhatsApp</h3>
            <p className="text-xs text-zinc-400">Requer a <b>Evolution API</b> (autoatendimento WhatsApp open source). Funciona igual ao Telegram — alertas + aprovação de IA por resposta.</p>

            <div className="space-y-3 text-xs text-zinc-400">
              <div className="flex gap-3">
                <span className="w-6 h-6 rounded-full bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center text-[10px] font-bold text-emerald-300 shrink-0">1</span>
                <div><b className="text-white">Instalar a Evolution API:</b> Siga a documentação em <code className="bg-zinc-900 px-1 rounded">doc.evolution-api.com</code>. Crie uma instância e conecte um número de WhatsApp via QR Code.</div>
              </div>
              <div className="flex gap-3">
                <span className="w-6 h-6 rounded-full bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center text-[10px] font-bold text-emerald-300 shrink-0">2</span>
                <div><b className="text-white">Configurar no painel:</b> Vá em <b>Usuários → Alertas WhatsApp</b>, informe a URL da Evolution API, nome da instância, API Key e o número de destino no formato <code>5511999998888</code>.</div>
              </div>
              <div className="flex gap-3">
                <span className="w-6 h-6 rounded-full bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center text-[10px] font-bold text-emerald-300 shrink-0">3</span>
                <div><b className="text-white">Registrar webhook:</b> Salve a configuração e clique em <b>📡 Registrar webhook (aprovações)</b>. O Nexus registra automaticamente o webhook na sua instância Evolution para receber respostas.</div>
              </div>
            </div>
            <p className="text-[10px] text-zinc-600">A aprovação funciona igual ao Telegram: responda <code>SIM CODIGO</code> ou <code>NÃO CODIGO</code> à mensagem do alerta.</p>
          </div>

          {/* ── 4. IA Remediação ── */}
          <div className="glass-panel rounded-2xl p-6 border border-zinc-800 space-y-4">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">🤖 IA Remediação com Aprovação Humana</h3>
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded-full text-[10px] bg-violet-500/15 text-violet-300 font-bold border border-violet-500/20">Plano Pro / Enterprise</span>
              <span className="text-[10px] text-zinc-600">Add-on disponível no plano Pro e superiores</span>
            </div>
            <p className="text-xs text-zinc-400">A IA monitora CPU, RAM e disco de cada máquina. Quando detecta anomalia, <b>propõe ações de correção e aguarda sua aprovação</b> antes de agir — zero ação sem autorização humana.</p>

            <div className="space-y-2">
              <p className="text-xs font-semibold text-zinc-300">Como ativar:</p>
              <div className="space-y-2 text-xs text-zinc-400">
                <div className="flex items-start gap-2"><span className="text-violet-400 shrink-0 mt-0.5">1.</span><span>Ative a <b className="text-white">IA Global</b> em <b>Segurança → Regras de alerta → IA remediação global</b>.</span></div>
                <div className="flex items-start gap-2"><span className="text-violet-400 shrink-0 mt-0.5">2.</span><span>Em cada máquina, acesse a aba <b className="text-white">Visão</b> → configure <b>criticidade</b> e ative <b>IA remediação</b>.</span></div>
                <div className="flex items-start gap-2"><span className="text-violet-400 shrink-0 mt-0.5">3.</span><span>Configure Telegram e/ou WhatsApp para receber alertas (necessário para aprovar via chat).</span></div>
                <div className="flex items-start gap-2"><span className="text-violet-400 shrink-0 mt-0.5">4.</span><span>Quando a IA detectar problema, você recebe mensagem com código. Responda <code>SIM CODIGO</code> ou aprove pelo painel em <b>Segurança → Aprovações Pendentes</b>.</span></div>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { k: "Missão Crítica", d: "Alerta imediato, prioridade máxima", cor: "red" },
                { k: "Crítico", d: "Alerta com urgência alta", cor: "orange" },
                { k: "Importante", d: "Alerta normal", cor: "amber" },
                { k: "Operacional", d: "Monitoramento passivo", cor: "zinc" },
              ].map(({ k, d, cor }) => (
                <div key={k} className={`p-3 rounded-xl bg-zinc-900/50 border border-zinc-800/60 text-xs`}>
                  <div className={`font-bold mb-1 text-${cor}-400`}>{k}</div>
                  <div className="text-zinc-500 text-[10px]">{d}</div>
                </div>
              ))}
            </div>

            <div className="bg-zinc-950 rounded-xl p-3 border border-zinc-800/80 text-[10px] text-zinc-500 space-y-1">
              <p className="font-semibold text-zinc-400">Cooldown e limites de segurança:</p>
              <p>• Máximo 1 aprovação pendente por máquina ao mesmo tempo (cooldown 30 min)</p>
              <p>• Aprovação expira em <b className="text-zinc-400">10 minutos</b> se não houver resposta</p>
              <p>• Ações possíveis: limpeza de temporários, cache DNS, reiniciar serviços parados</p>
              <p>• Tudo auditado: quem aprovou, quando, qual canal (web / Telegram / WhatsApp)</p>
            </div>
          </div>

          {/* ── 5. Planos ── */}
          <div className="glass-panel rounded-2xl p-6 border border-zinc-800 space-y-4">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">💳 Planos e Funcionalidades</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-zinc-500 border-b border-zinc-800">
                    <th className="text-left py-2 pr-4 font-semibold">Funcionalidade</th>
                    <th className="text-center py-2 px-3 font-semibold">Trial</th>
                    <th className="text-center py-2 px-3 font-semibold">Essencial</th>
                    <th className="text-center py-2 px-3 font-semibold text-emerald-400">Pro</th>
                    <th className="text-center py-2 px-3 font-semibold">Enterprise</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60">
                  {[
                    ["Máquinas", "1", "25", "150", "Ilimitado"],
                    ["Acesso remoto (tela)", "✅", "✅", "✅", "✅"],
                    ["Terminal PowerShell/CMD/Bash", "✅", "✅", "✅", "✅"],
                    ["Relatórios básicos", "✅", "✅", "✅", "✅"],
                    ["Serviços Windows / Linux", "—", "✅", "✅", "✅"],
                    ["Arquivos", "—", "✅", "✅", "✅"],
                    ["Notificações (Telegram/WA/email)", "—", "✅", "✅", "✅"],
                    ["Múltiplas empresas (multi-tenant)", "—", "✅", "✅", "✅"],
                    ["Relatórios avançados (auditoria)", "—", "—", "✅", "✅"],
                    ["Gestão de manutenção", "—", "—", "✅", "✅"],
                    ["Biblioteca de scripts", "—", "—", "✅", "✅"],
                    ["Portal do cliente", "—", "—", "✅", "✅"],
                    ["IA remediação + aprovação humana", "—", "—", "✅", "✅"],
                  ].map(([feat, trial, ess, pro, ent]) => (
                    <tr key={feat} className="hover:bg-zinc-900/30">
                      <td className="py-2 pr-4 text-zinc-300">{feat}</td>
                      <td className="py-2 px-3 text-center text-zinc-500">{trial}</td>
                      <td className="py-2 px-3 text-center text-zinc-400">{ess}</td>
                      <td className="py-2 px-3 text-center text-emerald-400 font-semibold">{pro}</td>
                      <td className="py-2 px-3 text-center text-zinc-400">{ent}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[10px] text-zinc-600">Para mudar de plano acesse <b className="text-zinc-400">Planos & Cobrança</b> no menu lateral. O plano Trial é gratuito por tempo indeterminado com 1 máquina.</p>
          </div>

          {/* ── 6. FAQ ── */}
          <div className="glass-panel rounded-2xl p-6 border border-zinc-800 space-y-4">
            <h3 className="text-sm font-bold text-white">❓ Perguntas Frequentes</h3>
            <div className="space-y-4">
              {[
                {
                  q: "O agente precisa de porta de entrada aberta no firewall?",
                  a: "Não. O agente faz conexão de saída (outbound) para o servidor via WebSocket seguro (wss://rmm.gmtec.tec.br:8443). Nenhuma porta precisa ser aberta no firewall da máquina monitorada.",
                },
                {
                  q: "O acesso remoto à tela funciona sem VNC ou RDP?",
                  a: "Sim. Usamos captura DXGI nativa do Windows (DirectX Desktop Duplication) — sem VNC, sem licença, sem driver de terceiros. O streaming vai pelo mesmo canal mTLS autenticado.",
                },
                {
                  q: "Como gero um token para cadastrar uma nova máquina?",
                  a: "Vá em Máquinas → Cadastrar Nova Máquina (botão verde no canto superior direito). O painel gera um token único de 24h. Use-o no comando de instalação.",
                },
                {
                  q: "Posso ter múltiplos técnicos com níveis de acesso diferentes?",
                  a: "Sim. Crie usuários em Usuários → Novo Usuário e atribua o papel: Owner (tudo), Admin (tudo exceto billing), Operator (controle remoto e terminal), Viewer (somente leitura), Cliente (vê só as próprias máquinas).",
                },
                {
                  q: "Como o isolamento entre empresas funciona?",
                  a: "Cada tenant tem um ID único. Toda tabela de dados tem tenant_id com Row Level Security (RLS) ativo no PostgreSQL — é impossível ver dados de outro tenant mesmo com SQL injection.",
                },
                {
                  q: "O que acontece se a IA tentar remediar e der errado?",
                  a: "Todas as ações da IA são auditadas e registradas com status (sucesso/falha). As ações disponíveis são conservadoras (limpeza de temp, cache DNS, reiniciar serviços parados) — nada destrutivo. E sempre dependem de aprovação humana antes.",
                },
                {
                  q: "O agente Linux suporta serviços systemd?",
                  a: "Sim. No Linux, o agente detecta e lista serviços via systemctl automaticamente. Iniciar/parar/reiniciar serviços funciona da mesma forma que no Windows.",
                },
              ].map(({ q, a }) => (
                <details key={q} className="group border border-zinc-800 rounded-xl overflow-hidden">
                  <summary className="flex items-center justify-between px-4 py-3 cursor-pointer text-xs font-semibold text-zinc-300 hover:text-white hover:bg-zinc-900/40 transition-colors list-none">
                    {q}
                    <span className="text-zinc-600 group-open:rotate-180 transition-transform text-base leading-none">›</span>
                  </summary>
                  <div className="px-4 py-3 text-[11px] text-zinc-400 border-t border-zinc-800/60 bg-zinc-900/20">{a}</div>
                </details>
              ))}
            </div>
          </div>

          {/* ── 7. Suporte ── */}
          <div className="glass-panel rounded-2xl p-6 border border-zinc-800 flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-white mb-1">🆘 Suporte</h3>
              <p className="text-xs text-zinc-400">Ficou com dúvida ou encontrou um problema? Fale diretamente com a equipe.</p>
            </div>
            <div className="flex gap-3 shrink-0">
              <a
                href="https://wa.me/5565984174850?text=Suporte%20Nexus%20RMM"
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-xs font-semibold text-emerald-300 cursor-pointer transition-colors"
              >
                💬 WhatsApp
              </a>
              <a
                href="mailto:suporte@gmtec.tec.br"
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs font-semibold text-zinc-300 cursor-pointer transition-colors"
              >
                ✉️ E-mail
              </a>
            </div>
          </div>

        </main>
      )}

      {/* Mobile bottom navigation */}
      <BottomNav
        secao={secao}
        alertasNaoLidas={alertasNaoLidas}
        socketConectado={socketConectado}
        pode={pode}
        onNavegar={(s) => { setSecao(s as any); setEmpresaFoco(null); }}
        onAbrirMenu={() => setMobileMenuOpen(true)}
      />

      {/* Mobile drawer menu */}
      <MobileMenu
        open={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
        secao={secao}
        user={user}
        pode={pode}
        socketConectado={socketConectado}
        onNavegar={(s) => { setSecao(s as any); setEmpresaFoco(null); }}
        onAbrirChamados={abrirChamados}
        onAbrirTarefas={abrirTarefas}
        onAbrirUsuarios={abrirUsuarios}
        onAbrirSeguranca={abrirSeguranca}
        onAbrirPlanos={abrirPlanos}
        onAbrirTenants={abrirTenants}
        onLogout={handleLogout}
      />
    </div>
  );
}
