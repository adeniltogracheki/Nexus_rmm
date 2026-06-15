// ============================================================================
//  Nexus RMM — Spike da Tela · AGENTE (roda na máquina Windows)
//  - Abre conexão WSS OUTBOUND para o relay (sem abrir porta de entrada no PC).
//  - Quando um viewer conecta, faz a ponte entre o WSS e o VNC local (loopback).
//  Segurança: VNC só em 127.0.0.1; tudo na rede vai cifrado (WSS/TLS).
// ============================================================================
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RELAY_URL = process.env.SPIKE_RELAY_URL || "";       // wss://sis.gmtec.tec.br/spike/agent
const AGENT_TOKEN = process.env.SPIKE_AGENT_TOKEN || "";
const VNC_HOST = process.env.SPIKE_VNC_HOST || "127.0.0.1";
const VNC_PORT = Number(process.env.SPIKE_VNC_PORT || 5900);

if (!RELAY_URL || !AGENT_TOKEN) {
  console.error("✗ Defina SPIKE_RELAY_URL e SPIKE_AGENT_TOKEN no ambiente.");
  process.exit(1);
}

// Tenta encontrar o machineId da maquina
let machineId = process.env.NEXUS_MACHINE_ID || "";
if (!machineId) {
  const pathsToTry = [];
  if (process.env.LOCALAPPDATA) {
    pathsToTry.push(path.join(process.env.LOCALAPPDATA, "NexusAgente", "agent-state.json"));
  }
  pathsToTry.push(path.join(__dirname, "agent-state.json"));
  pathsToTry.push(path.join(__dirname, "..", "..", "agente", "agent-state.json"));
  pathsToTry.push(path.join(__dirname, "..", "agente", "agent-state.json"));

  for (const p of pathsToTry) {
    if (fs.existsSync(p)) {
      try {
        const state = JSON.parse(fs.readFileSync(p, "utf8"));
        if (state && state.machineId) {
          machineId = state.machineId;
          console.log(`• ID da maquina detectado no arquivo de estado (${p}): ${machineId}`);
          break;
        }
      } catch (e) {
        console.error(`Aviso: erro ao ler o arquivo de estado em ${p}:`, e.message);
      }
    }
  }
}

if (!machineId) {
  console.warn("⚠️ Aviso: machineId nao encontrado no ambiente ou nos arquivos de estado.");
}

let backoff = 1000;
const BACKOFF_MAX = 30_000;

function conectar() {
  let url = `${RELAY_URL}?token=${encodeURIComponent(AGENT_TOKEN)}&hostname=${encodeURIComponent(os.hostname())}`;
  if (machineId) {
    url += `&machineId=${encodeURIComponent(machineId)}`;
  }
  const ws = new WebSocket(url);
  ws.binaryType = "nodebuffer";
  let vnc = null;

  const fecharVnc = () => {
    if (vnc) { try { vnc.destroy(); } catch {} vnc = null; }
  };

  ws.on("open", () => {
    backoff = 1000;
    console.log("✓ conectado ao relay:", RELAY_URL);
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      // bytes do viewer -> VNC local
      if (vnc && !vnc.destroyed) vnc.write(data);
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === "open") {
      fecharVnc();
      console.log(`→ viewer conectou; abrindo VNC ${VNC_HOST}:${VNC_PORT}`);
      vnc = net.connect(VNC_PORT, VNC_HOST);
      vnc.on("connect", () => console.log("  VNC local ok"));
      vnc.on("data", (buf) => { if (ws.readyState === WebSocket.OPEN) ws.send(buf, { binary: true }); });
      vnc.on("close", () => { console.log("  VNC fechado"); });
      vnc.on("error", (e) => {
        console.error("  erro VNC:", e.message);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "vnc-error", erro: e.message }));
      });
    } else if (msg.type === "close") {
      console.log("→ viewer saiu; fechando VNC");
      fecharVnc();
    }
  });

  ws.on("close", () => {
    fecharVnc();
    console.log(`✗ relay caiu; reconectando em ${Math.round(backoff / 1000)}s`);
    setTimeout(conectar, backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX);
  });

  ws.on("error", (e) => { console.error("erro WS:", e.message); });
}

console.log("Nexus spike-agent iniciando…");
conectar();
