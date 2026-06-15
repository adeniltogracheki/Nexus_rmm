import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";

export interface BriefingInput {
  totalMaquinas: number;
  online: number;
  offline: number;
  maquinasOffline: Array<{ nome: string; offlineHa: string }>;
  alertasCriticos: number;
  alertasNaoLidos: number;
  discosEmRisco: Array<{ maquina: string; disco: string; pct: number; diasRestantes: number | null }>;
  healthScoreMedia: number | null;
  hora: number; // 0-23, para saudação
}

export async function gerarBriefing(input: BriefingInput): Promise<string> {
  if (!config.ANTHROPIC_API_KEY) {
    return gerarBriefingSimples(input);
  }

  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const prompt = `Você é um assistente de TI que gera briefings curtos e diretos sobre a saúde da infraestrutura.

Dados atuais:
- Total de máquinas: ${input.totalMaquinas}
- Online: ${input.online}
- Offline: ${input.offline}${input.maquinasOffline.length > 0 ? `\n- Máquinas offline: ${input.maquinasOffline.map((m) => `${m.nome} (há ${m.offlineHa})`).join(", ")}` : ""}
- Alertas críticos não lidos: ${input.alertasCriticos}
- Total alertas não lidos: ${input.alertasNaoLidos}${input.discosEmRisco.length > 0 ? `\n- Discos em risco: ${input.discosEmRisco.map((d) => `${d.maquina}/${d.disco} em ${d.pct}%${d.diasRestantes ? ` (cheio em ~${d.diasRestantes} dias)` : ""}`).join(", ")}` : ""}${input.healthScoreMedia !== null ? `\n- Health Score médio da infraestrutura: ${input.healthScoreMedia}/100` : ""}

Gere um briefing CURTO (máx 3 frases) em português brasileiro. Comece com saudação baseada na hora (${input.hora}h). Seja direto: mencione só o que precisa de atenção. Se tudo estiver bem, diga isso em uma frase. NÃO use markdown, NÃO use bullet points, apenas texto corrido.`;

  const message = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 200,
    messages: [{ role: "user", content: prompt }],
  });

  return (message.content[0] as { text: string }).text;
}

// Fallback sem LLM
function gerarBriefingSimples(input: BriefingInput): string {
  const saudacao = input.hora < 12 ? "Bom dia" : input.hora < 18 ? "Boa tarde" : "Boa noite";
  const partes: string[] = [`${saudacao}.`];

  if (input.offline === 0) {
    partes.push(`Todas as ${input.totalMaquinas} máquinas estão online.`);
  } else {
    partes.push(
      `${input.online} de ${input.totalMaquinas} máquinas online — ${input.offline} offline${input.maquinasOffline.length > 0 ? ` (${input.maquinasOffline.map((m) => m.nome).join(", ")})` : ""}.`,
    );
  }

  if (input.alertasCriticos > 0) {
    partes.push(
      `${input.alertasCriticos} alerta${input.alertasCriticos > 1 ? "s" : ""} crítico${input.alertasCriticos > 1 ? "s" : ""} não lido${input.alertasCriticos > 1 ? "s" : ""}.`,
    );
  }

  if (input.discosEmRisco.length > 0) {
    const d = input.discosEmRisco[0]!;
    partes.push(`Disco ${d.disco} em ${d.pct}%${d.diasRestantes ? ` — cheio em ~${d.diasRestantes} dias` : ""}.`);
  }

  if (input.alertasCriticos === 0 && input.offline === 0 && input.discosEmRisco.length === 0) {
    partes.push("Infraestrutura saudável, nada requer atenção imediata.");
  }

  return partes.join(" ");
}
