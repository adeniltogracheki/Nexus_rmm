import { config } from "../config";

export interface DiagnosticoInput {
  maquina: {
    hostname: string;
    apelido: string | null;
    online: boolean;
    soVersao: string | null;
    vistoEm: Date | null;
    tipoMaquina: string;
  };
  healthScore: number | null;
  componentes: {
    cpuMedia: number | null;
    ramMedia: number | null;
    discoUsoPct: number | null;
    uptimePct: number;
    alertasCriticos: number;
    alertasAvisos: number;
  };
  alertasRecentes: Array<{
    tipo: string;
    severidade: string;
    mensagem: string;
    criadoEm: Date;
  }>;
  cpuPico: number | null;
  ramPico: number | null;
}

export interface DiagnosticoResult {
  severidade: "critica" | "alta" | "media" | "baixa";
  causa: string;
  acoes: string[];
  geradoEm: string;
  semIA?: boolean;
}

export async function diagnosticarMaquina(input: DiagnosticoInput): Promise<DiagnosticoResult> {
  if (!config.ANTHROPIC_API_KEY) {
    return diagnosticarSemIA(input);
  }

  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const nomeMaquina = input.maquina.apelido || input.maquina.hostname;
  const offlineHa = !input.maquina.online && input.maquina.vistoEm
    ? Math.round((Date.now() - new Date(input.maquina.vistoEm).getTime()) / 60000)
    : null;

  const alertasTexto = input.alertasRecentes.length > 0
    ? input.alertasRecentes.map((a) =>
        `  - [${a.severidade.toUpperCase()}] ${a.tipo}: ${a.mensagem} (${new Date(a.criadoEm).toLocaleString("pt-BR")})`
      ).join("\n")
    : "  - Nenhum alerta ativo";

  const prompt = `Você é um especialista em diagnóstico de infraestrutura de TI. Analise os dados abaixo e identifique a causa provável do problema, retornando um diagnóstico estruturado em JSON.

## Dados da máquina: ${nomeMaquina}
- Status: ${input.maquina.online ? "ONLINE" : `OFFLINE${offlineHa != null ? ` há ${offlineHa} minutos` : ""}`}
- SO: ${input.maquina.soVersao || "desconhecido"}
- Tipo: ${input.maquina.tipoMaquina}
- Health Score: ${input.healthScore != null ? `${input.healthScore}/100` : "indisponível"}

## Métricas (últimas 2h de média)
- CPU média: ${input.componentes.cpuMedia != null ? `${input.componentes.cpuMedia}%` : "sem dados"}
- CPU pico (última 1h): ${input.cpuPico != null ? `${input.cpuPico}%` : "sem dados"}
- RAM média: ${input.componentes.ramMedia != null ? `${input.componentes.ramMedia}%` : "sem dados"}
- RAM pico (última 1h): ${input.ramPico != null ? `${input.ramPico}%` : "sem dados"}
- Disco mais usado: ${input.componentes.discoUsoPct != null ? `${input.componentes.discoUsoPct}%` : "sem dados"}
- Uptime (7 dias): ${input.componentes.uptimePct}%

## Alertas ativos (últimas 24h)
${alertasTexto}

## Contadores
- Alertas críticos: ${input.componentes.alertasCriticos}
- Alertas de aviso: ${input.componentes.alertasAvisos}

Responda APENAS com JSON no formato:
{
  "severidade": "critica" | "alta" | "media" | "baixa",
  "causa": "Uma frase clara identificando a causa principal do problema",
  "acoes": [
    "Ação 1 — específica e acionável",
    "Ação 2",
    "Ação 3"
  ]
}

Regras:
- severidade "critica" = máquina offline OU health score < 20 OU CPU/RAM > 95%
- severidade "alta" = health score 20-40 OU CPU/RAM > 80% OU disco > 90%
- severidade "media" = health score 40-60 OU alertas de aviso frequentes
- severidade "baixa" = health score > 60 mas com pontos a monitorar
- causa deve ser em português, uma única frase objetiva
- acoes: exatamente 3 ações, em português, específicas para este caso
- NÃO inclua markdown, apenas JSON puro`;

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });

    const text = (message.content[0] as { text: string }).text;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("no json");

    const parsed = JSON.parse(match[0]);

    // Validate structure
    const severidades = ["critica", "alta", "media", "baixa"] as const;
    const sev: "critica" | "alta" | "media" | "baixa" = severidades.includes(parsed.severidade)
      ? parsed.severidade
      : "media";

    return {
      severidade: sev,
      causa: typeof parsed.causa === "string" ? parsed.causa : "Problema identificado na máquina.",
      acoes: Array.isArray(parsed.acoes) ? parsed.acoes.slice(0, 5) : ["Verificar logs do sistema.", "Reiniciar o agente.", "Contatar suporte técnico."],
      geradoEm: new Date().toISOString(),
    };
  } catch {
    // IA falhou — usa fallback determinístico
    return diagnosticarSemIA(input);
  }
}

// Diagnóstico determinístico sem LLM
function diagnosticarSemIA(input: DiagnosticoInput): DiagnosticoResult {
  const c = input.componentes;
  const acoes: string[] = [];
  let severidade: "critica" | "alta" | "media" | "baixa" = "baixa";
  let causa = "";

  // Prioridade 1 — offline
  if (!input.maquina.online) {
    severidade = "critica";
    causa = "Máquina sem comunicação com o servidor RMM — agente offline ou host inacessível.";
    acoes.push(
      "Verificar se o computador está ligado e com rede ativa.",
      "Checar se o serviço do agente Nexus RMM está rodando (services.msc → NexusRMM).",
      "Testar conectividade com o servidor: ping rmm.gmtec.tec.br."
    );
    return { severidade, causa, acoes, geradoEm: new Date().toISOString(), semIA: true };
  }

  // Prioridade 2 — alertas críticos
  if (c.alertasCriticos >= 3) {
    severidade = "critica";
    const tiposAlertas = [...new Set(input.alertasRecentes.filter(a => a.severidade === "critico").map(a => a.tipo))].join(", ");
    causa = `Múltiplos alertas críticos ativos (${c.alertasCriticos}) — tipos: ${tiposAlertas || "variados"}.`;
    acoes.push(
      `Revisar e tratar os ${c.alertasCriticos} alertas críticos no painel de alertas.`,
      "Verificar logs de eventos do Windows (eventvwr.msc) para erros recentes.",
      "Confirmar se o watchdog está respondendo corretamente."
    );
    return { severidade, causa, acoes, geradoEm: new Date().toISOString(), semIA: true };
  }

  // Prioridade 3 — CPU crítica
  const cpu = input.cpuPico ?? c.cpuMedia;
  if (cpu != null && cpu >= 90) {
    severidade = "alta";
    causa = `CPU em uso extremo (pico de ${cpu}%) — processo provável: indexação, antivírus ou aplicação com vazamento.`;
    acoes.push(
      "Abrir Gerenciador de Tarefas (Ctrl+Shift+Esc) e identificar o processo com maior CPU.",
      `Verificar se há rotinas agendadas ativas no horário: ${new Date().toLocaleTimeString("pt-BR")}.`,
      "Considerar reiniciar o processo ou escalonar a investigação para o responsável."
    );
    return { severidade, causa, acoes, geradoEm: new Date().toISOString(), semIA: true };
  }

  // Prioridade 4 — RAM crítica
  const ram = input.ramPico ?? c.ramMedia;
  if (ram != null && ram >= 90) {
    severidade = "alta";
    causa = `Memória RAM saturada (${ram}%) — risco de instabilidade e degradação de desempenho.`;
    acoes.push(
      "Identificar processos com maior consumo de RAM via Gerenciador de Tarefas.",
      "Fechar aplicações não essenciais ou aumentar a memória virtual (arquivo de paginação).",
      "Avaliar upgrade de RAM se o consumo for recorrente."
    );
    return { severidade, causa, acoes, geradoEm: new Date().toISOString(), semIA: true };
  }

  // Prioridade 5 — disco cheio
  if (c.discoUsoPct != null && c.discoUsoPct >= 90) {
    severidade = c.discoUsoPct >= 95 ? "critica" : "alta";
    causa = `Disco com ${c.discoUsoPct}% de uso — risco de falha do SO por falta de espaço.`;
    acoes.push(
      "Executar limpeza de disco: cleanmgr.exe → marcar 'Arquivos temporários' e 'Lixeira'.",
      "Verificar logs e dumps em C:\\Windows\\Logs e deletar arquivos antigos.",
      "Avaliar expansão do volume ou migração de dados para storage externo."
    );
    return { severidade, causa, acoes, geradoEm: new Date().toISOString(), semIA: true };
  }

  // Prioridade 6 — uptime baixo
  if (c.uptimePct < 70) {
    severidade = "media";
    causa = `Uptime de apenas ${Math.round(c.uptimePct)}% nos últimos 7 dias — instabilidade recorrente de conexão ou reinicializações frequentes.`;
    acoes.push(
      "Verificar logs de desligamento: Get-WinEvent -FilterHashtable @{LogName='System';Id=1074,6005,6006} | Select-Object -First 10",
      "Checar se há atualizações do Windows agendadas causando reinicializações.",
      "Monitorar a estabilidade de energia (nobreak/UPS) se for servidor físico."
    );
    return { severidade, causa, acoes, geradoEm: new Date().toISOString(), semIA: true };
  }

  // Prioridade 7 — Health Score baixo genérico
  if (input.healthScore != null && input.healthScore < 50) {
    severidade = "media";
    causa = `Health Score de ${input.healthScore}/100 indica degradação acumulada em múltiplos componentes.`;
    acoes.push(
      "Revisar os alertas de aviso pendentes e tratar os mais antigos.",
      "Verificar CPU, RAM e disco individualmente na aba Visão Geral.",
      "Agendar manutenção preventiva para identificar gargalos."
    );
    return { severidade, causa, acoes, geradoEm: new Date().toISOString(), semIA: true };
  }

  // Padrão — nada crítico identificado
  severidade = "baixa";
  causa = "Nenhum problema crítico identificado — monitoramento preventivo recomendado.";
  acoes.push(
    "Manter o agente atualizado para garantir coleta precisa de métricas.",
    "Revisar alertas de aviso para antecipar problemas futuros.",
    "Agendar manutenção preventiva semestral."
  );
  return { severidade, causa, acoes, geradoEm: new Date().toISOString(), semIA: true };
}
