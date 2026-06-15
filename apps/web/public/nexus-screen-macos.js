#!/usr/bin/env node
// nexus-screen-macos.js — Helper de tela remota para macOS (Nexus RMM)
// Serve WebSocket em 127.0.0.1:7701 com o mesmo protocolo do nexus-screen.exe.
//
// Captura: screencapture -z -t jpg (nativo macOS, sem deps)
// Input:   osascript + key codes (nativo macOS, sem deps)
//
// Executado pelo agente Nexus RMM em /opt/nexus-rmm/
// Requer: Node.js 18+, macOS 12+
// Para input de mouse/teclado: permissão de Acessibilidade ou rodar como root.
//
// Protocolo binário (mesmo do nexus-screen.exe):
//   Frames: [0x01][4B width LE][4B height LE][JPEG data]
//   Comandos JSON: {"cmd":"mouse","x":0.5,"y":0.3,"buttons":1}
//                  {"cmd":"key","vk":65,"down":true}
//                  {"cmd":"scroll","x":0.5,"y":0.3,"delta":-3}
//                  {"cmd":"qualidade","q":75}
//                  {"cmd":"monitor","idx":0}
//                  {"cmd":"fps","v":10}

"use strict";
const { createServer }  = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const { execFile, execSync } = require("child_process");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ── config ───────────────────────────────────────────────────────────────────
const PORT    = parseInt(process.env.NEXUS_SCREEN_PORT || "7701", 10);
const ADDR    = "127.0.0.1";
const TMP_A   = path.join(os.tmpdir(), "nexus-screen-a.jpg");
const TMP_B   = path.join(os.tmpdir(), "nexus-screen-b.jpg");

let quality   = 65;  // JPEG quality
let fps       = 10;  // frames per second (screencapture é mais lento que DXGI)
let monIdx    = 0;   // monitor index

// ── mapeamento VK (Windows) → key code macOS ─────────────────────────────────
// https://eastmanreference.com/complete-list-of-applescript-key-codes
const VK_TO_KEYCODE = {
  // Letras
  65:0, 66:11, 67:8, 68:2, 69:14, 70:3, 71:5, 72:4,
  73:34, 74:38, 75:40, 76:37, 77:46, 78:45, 79:31,
  80:35, 81:12, 82:15, 83:1, 84:17, 85:32, 86:9,
  87:13, 88:7, 89:16, 90:6,
  // Dígitos
  48:29, 49:18, 50:19, 51:20, 52:21, 53:23, 54:22, 55:26, 56:28, 57:25,
  // Numpad
  96:82, 97:83, 98:84, 99:85, 100:86, 101:87, 102:88, 103:89, 104:91, 105:92,
  107:69, 109:78, 106:67, 111:75, 110:65,
  // Teclas especiais
  13:36,   // Enter
  8:51,    // Backspace
  9:48,    // Tab
  32:49,   // Space
  27:53,   // Escape
  46:117,  // Delete (forward delete no macOS)
  45:114,  // Insert (Help key macOS)
  36:115,  // Home
  35:119,  // End
  33:116,  // Page Up
  34:121,  // Page Down
  37:123,  // Arrow Left
  38:126,  // Arrow Up
  39:124,  // Arrow Right
  40:125,  // Arrow Down
  // F Keys
  112:122, 113:120, 114:99,  115:118, 116:96, 117:97,
  118:98,  119:100, 120:101, 121:109, 122:103, 123:111,
  // Modificadores
  16:56,   // Shift
  17:59,   // Control
  18:58,   // Option/Alt
  91:55,   // Cmd (Meta Left)
  92:54,   // Cmd Right
  20:57,   // CapsLock
  144:71,  // NumLock (Clear no macOS)
  // Símbolos
  189:27, 187:24, 219:33, 221:30, 220:42,
  186:41, 222:39, 188:43, 190:47, 191:44, 192:50,
};

// ── estado de tela ────────────────────────────────────────────────────────────
let screenW = 1920;
let screenH = 1080;
let tmpToggle = false; // alterna entre TMP_A e TMP_B

// Obtém resolução do display principal via osascript
function detectScreenSize() {
  try {
    const out = execSync(
      `osascript -e 'tell application "Finder" to get bounds of window of desktop'`,
      { timeout: 3000 }
    ).toString().trim();
    // "0, 0, 2560, 1440" ou "0, 0, 1920, 1080"
    const parts = out.split(",").map(s => parseInt(s.trim(), 10));
    if (parts.length === 4 && parts[2] > 100 && parts[3] > 100) {
      screenW = parts[2];
      screenH = parts[3];
      console.log(`[screen] Resolução detectada: ${screenW}×${screenH}`);
    }
  } catch (e) {
    console.warn("[screen] Não foi possível detectar resolução via osascript:", e.message);
  }
}

// ── captura de tela ───────────────────────────────────────────────────────────
function captureFrame(monitorIdx) {
  return new Promise((resolve) => {
    tmpToggle = !tmpToggle;
    const dest = tmpToggle ? TMP_A : TMP_B;
    const args = ["-z", "-t", "jpg", "-x"];
    // -D N: capturar monitor específico (1-based no screencapture)
    if (monitorIdx > 0) args.push("-D", String(monitorIdx + 1));
    args.push(dest);

    execFile("screencapture", args, { timeout: 3000 }, (err) => {
      if (err) { resolve(null); return; }
      try {
        const data = fs.readFileSync(dest);
        resolve(data);
      } catch {
        resolve(null);
      }
    });
  });
}

// ── build packet ──────────────────────────────────────────────────────────────
function buildPacket(w, h, jpegData) {
  const pkt = Buffer.allocUnsafe(9 + jpegData.length);
  pkt[0] = 0x01;
  pkt.writeUInt32LE(w, 1);
  pkt.writeUInt32LE(h, 5);
  jpegData.copy(pkt, 9);
  return pkt;
}

// ── input via osascript ───────────────────────────────────────────────────────
function osa(script) {
  execFile("osascript", ["-e", script], { timeout: 2000 }, () => {});
}

function appleMouseMove(x, y) {
  osa(`tell application "System Events" to set mousePos to {${x}, ${y}}`);
}

function appleMouseDown(x, y, btn) {
  // btn: 0=left, 2=right (AppleScript button: 1=left, 3=right)
  const b = btn === 2 ? 3 : 1;
  osa(`tell application "System Events" to click at {${x}, ${y}} using {button ${b}}`);
}

function appleMouseUp() {
  // osascript não tem mouseUp direto — clique já foi enviado no down
  // Mantemos estado do prevButtons para não enviar duplo clique
}

function appleScroll(x, y, delta) {
  const dir = delta > 0 ? "up" : "down";
  const amt = Math.abs(Math.round(delta)) || 1;
  osa(`tell application "System Events" to scroll ${dir} by ${amt} at {${x}, ${y}}`);
}

function appleKey(vk, down) {
  const kc = VK_TO_KEYCODE[vk];
  if (kc === undefined) return;
  if (down) {
    osa(`tell application "System Events" to key code ${kc}`);
  }
  // keyup não precisa de ação separada com keystroke/key code
}

// ── handler de comandos ───────────────────────────────────────────────────────
let prevButtons = 0;
let pendingMouseX = 0;
let pendingMouseY = 0;

function handleCmd(cmd) {
  const c = cmd.cmd;

  if (c === "qualidade") {
    const v = parseInt(cmd.q);
    if (v >= 1 && v <= 95) quality = v;
    return;
  }
  if (c === "monitor") {
    const v = parseInt(cmd.idx);
    if (!isNaN(v) && v >= 0) monIdx = v;
    return;
  }
  if (c === "fps") {
    const v = parseInt(cmd.v);
    if (v >= 1 && v <= 30) fps = v;
    return;
  }

  if (c === "mouse") {
    const absX = Math.round((cmd.x || 0) * screenW);
    const absY = Math.round((cmd.y || 0) * screenH);
    pendingMouseX = absX;
    pendingMouseY = absY;

    const buttons = cmd.buttons || 0;
    const prev = prevButtons;
    prevButtons = buttons;

    // move sempre
    osa(`tell application "System Events"
      set mousePos to {${absX}, ${absY}}
    end tell`);

    // botão esquerdo
    if ((buttons & 1) && !(prev & 1)) {
      osa(`tell application "System Events" to click at {${absX}, ${absY}}`);
    }
    // botão direito
    if ((buttons & 2) && !(prev & 2)) {
      osa(`tell application "System Events"
        set mousePos to {${absX}, ${absY}}
        key down {control}
        click at {${absX}, ${absY}}
        key up {control}
      end tell`);
    }
    return;
  }

  if (c === "mouseup") {
    prevButtons = 0;
    return;
  }

  if (c === "scroll") {
    const absX = Math.round((cmd.x || 0) * screenW);
    const absY = Math.round((cmd.y || 0) * screenH);
    const delta = Math.round(cmd.delta || 0);
    if (delta !== 0) {
      const dir   = delta > 0 ? "up" : "down";
      const count = Math.min(Math.abs(delta), 10);
      osa(`tell application "System Events" to scroll ${dir} by ${count} at {${absX}, ${absY}}`);
    }
    return;
  }

  if (c === "key") {
    const vk   = cmd.vk;
    const down = !!cmd.down;
    if (!down) return; // osascript key code dispara no keydown já
    const kc = VK_TO_KEYCODE[vk];
    if (kc !== undefined) {
      osa(`tell application "System Events" to key code ${kc}`);
    }
    return;
  }
}

// ── servidor WebSocket ────────────────────────────────────────────────────────
const server = createServer((_, res) => {
  res.writeHead(200);
  res.end("ok");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("[screen] viewer conectado");

  let alive = true;
  let frameTimer = null;

  ws.on("message", (data) => {
    try {
      const cmd = JSON.parse(data.toString());
      handleCmd(cmd);
    } catch {}
  });

  ws.on("close", () => {
    alive = false;
    if (frameTimer) clearTimeout(frameTimer);
    console.log("[screen] viewer desconectado");
  });

  ws.on("error", () => { alive = false; });

  let lastHash = "";

  async function sendFrame() {
    if (!alive || ws.readyState !== WebSocket.OPEN) return;

    const jpegBuf = await captureFrame(monIdx);
    if (jpegBuf && jpegBuf.length > 100) {
      // hash simples (primeiros 256 bytes do JPEG) para pular frames idênticos
      const hash = jpegBuf.slice(0, 256).toString("hex");
      if (hash !== lastHash) {
        lastHash = hash;
        const pkt = buildPacket(screenW, screenH, jpegBuf);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(pkt, { binary: true });
        }
      }
    }

    if (alive) {
      frameTimer = setTimeout(sendFrame, Math.round(1000 / fps));
    }
  }

  sendFrame();
});

// health check endpoint
server.on("request", (req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); }
  else if (req.url === "/monitores") {
    res.writeHead(200, { "Content-Type": "application/json" });
    // screencapture não lista monitores facilmente — retorna lista básica
    res.end(JSON.stringify([{ idx: 0, w: screenW, h: screenH, x: 0, y: 0 }]));
  } else { res.writeHead(404); res.end(); }
});

// ── init ─────────────────────────────────────────────────────────────────────
detectScreenSize();

server.listen(PORT, ADDR, () => {
  console.log(`[nexus-screen-macos] ouvindo em ws://${ADDR}:${PORT}`);
  console.log(`[nexus-screen-macos] resolução: ${screenW}×${screenH} | fps: ${fps} | qualidade: ${quality}`);
});

process.on("uncaughtException", (e) => console.error("[nexus-screen-macos] erro:", e.message));
