// ============================================================================
//  Nexus RMM — Spike da Tela · RELAY (roda no servidor Linux)
//  - Serve o viewer noVNC e a página de login em /spike/
//  - WSS /spike/agent : o agente do Windows conecta (autentica por token)
//  - WSS /spike/view  : o navegador (noVNC) conecta (autentica por senha->token)
//  - Faz a ponte de bytes entre os dois (websockify distribuído).
//  Segurança: tudo atrás do Traefik (TLS). VNC nunca trafega cru na rede.
// ============================================================================
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.SPIKE_RELAY_PORT || 7700);
const BASE = "/spike";
const AGENT_TOKEN = process.env.SPIKE_AGENT_TOKEN || "";
const VIEW_PASSWORD = process.env.SPIKE_VIEW_PASSWORD || "";
const VNC_PASSWORD = process.env.SPIKE_VNC_PASSWORD || "";
// Segredo compartilhado com o servidor para validar o GRANT EFÊMERO de tela (JWT HS256).
const GRANT_SECRET = process.env.SCREEN_GRANT_SECRET || "";

function b64urlToBuf(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
// Valida um grant efêmero emitido pelo servidor (substitui a senha manual no fluxo do painel).
function verifyGrant(token) {
  if (!GRANT_SECRET || !token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [h, p, s] = parts;
  const expected = crypto.createHmac("sha256", GRANT_SECRET).update(h + "." + p).digest();
  let got;
  try { got = b64urlToBuf(s); } catch { return false; }
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return false;
  let payload;
  try { payload = JSON.parse(b64urlToBuf(p).toString("utf8")); } catch { return false; }
  if (payload.typ !== "screen") return false;
  if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) return false;
  return true;
}
function extrairDadosDoToken(token) {
  if (!token) return { machineId: "default", hostname: "" };
  const parts = token.split(".");
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(b64urlToBuf(parts[1]).toString("utf8"));
      if (payload.typ === "screen") {
        return {
          machineId: payload.machineId || "default",
          hostname: payload.hostname || ""
        };
      }
    } catch (e) {}
  }
  return { machineId: "default", hostname: "" };
}
function viewerAutorizado(token) {
  return tokenViewValido(token) || verifyGrant(token);
}
// Grant efêmero do AGENTE (typ "screen-agent") emitido pelo servidor via mTLS.
function verifyAgentGrant(token) {
  if (!GRANT_SECRET || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = crypto.createHmac("sha256", GRANT_SECRET).update(h + "." + p).digest();
  let got;
  try { got = b64urlToBuf(s); } catch { return null; }
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  let payload;
  try { payload = JSON.parse(b64urlToBuf(p).toString("utf8")); } catch { return null; }
  if (payload.typ !== "screen-agent") return null;
  if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) return null;
  return { machineId: payload.machineId || "default" };
}
// Segredo do JWT do PAINEL — pra exigir sessão logada (evita URL vazada funcionar sozinha).
const JWT_SECRET = process.env.JWT_SECRET || GRANT_SECRET;
function verifyJwtHs256(token, secret) {
  if (!token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = crypto.createHmac("sha256", secret).update(h + "." + p).digest();
  let got; try { got = b64urlToBuf(s); } catch { return null; }
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  let payload; try { payload = JSON.parse(b64urlToBuf(p).toString("utf8")); } catch { return null; }
  if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) return null;
  return payload;
}
function lerCookie(cookieHeader, nome) {
  if (!cookieHeader) return "";
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === nome) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}
// Sessão do painel válida E do mesmo tenant do grant da tela?
function sessaoPainelOk(cookieHeader, grantToken) {
  const sessao = verifyJwtHs256(lerCookie(cookieHeader, "nexus_at"), JWT_SECRET);
  if (!sessao || !sessao.tenantId) return false;
  try {
    const gp = JSON.parse(b64urlToBuf(grantToken.split(".")[1]).toString("utf8"));
    if (gp.tenantId && gp.tenantId !== sessao.tenantId) return false;
  } catch { return false; }
  return true;
}
const NOVNC_DIR = process.env.NOVNC_DIR || path.join(__dirname, "node_modules", "@novnc", "novnc");

if (!AGENT_TOKEN || !VIEW_PASSWORD) {
  console.error("✗ Defina SPIKE_AGENT_TOKEN e SPIKE_VIEW_PASSWORD no ambiente.");
  process.exit(1);
}

// --- estado multi-dispositivos (mapeado por machineId e hostname) ----------
const agentSocks = new Map();          // machineId -> ws
const agentSocksByHostname = new Map();  // hostname (lowercase) -> ws
const viewerSocks = new Map();         // machineId/hostname -> ws
const viewTokens = new Map();          // token -> expiraEm(ms)
const usedGrants = new Set();          // tokens efêmeros já utilizados (single-use)

function novoTokenView() {
  const t = crypto.randomBytes(24).toString("hex");
  viewTokens.set(t, Date.now() + 5 * 60_000); // 5 min
  return t;
}
function tokenViewValido(t) {
  const exp = viewTokens.get(t);
  if (!exp) return false;
  if (Date.now() > exp) { viewTokens.delete(t); return false; }
  return true;
}
setInterval(() => {
  const agora = Date.now();
  for (const [t, exp] of viewTokens) if (agora > exp) viewTokens.delete(t);
  
  // Limpa tokens efêmeros expirados do Set de uso único
  const agoraSegundos = agora / 1000;
  for (const token of usedGrants) {
    try {
      const parts = token.split(".");
      const payload = JSON.parse(b64urlToBuf(parts[1]).toString("utf8"));
      if (typeof payload.exp === "number" && agoraSegundos > payload.exp) {
        usedGrants.delete(token);
      }
    } catch {
      usedGrants.delete(token);
    }
  }
}, 60_000).unref();

// --- MIME ------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function servirArquivo(res, arquivo) {
  fs.readFile(arquivo, (err, buf) => {
    if (err) { res.writeHead(404).end("não encontrado"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(arquivo)] || "application/octet-stream" });
    res.end(buf);
  });
}

// --- páginas ---------------------------------------------------------------
function paginaLogin(msg = "") {
  return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexus RMM — Tela remota (spike)</title>
<style>body{font-family:system-ui,sans-serif;background:#0b1020;color:#e6e9f0;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#151b2e;padding:32px;border-radius:14px;box-shadow:0 10px 40px #0008;width:320px}
h1{font-size:18px;margin:0 0 4px}p{color:#9aa3b7;font-size:13px;margin:0 0 20px}
input{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #2a3350;background:#0b1020;color:#fff;margin-bottom:12px}
button{width:100%;padding:12px;border:0;border-radius:8px;background:#4f7cff;color:#fff;font-weight:600;cursor:pointer}
.err{color:#ff7a7a;font-size:13px;margin-bottom:10px}</style></head>
<body><form class="card" method="POST" action="${BASE}/login">
<h1>🖥️ Tela remota — Nexus RMM</h1><p>Spike de prova. Acesso restrito.</p>
${msg ? `<div class="err">${msg}</div>` : ""}
<input type="password" name="senha" placeholder="Senha de acesso" autofocus>
<button type="submit">Entrar</button></form></body></html>`;
}


// Viewer canvas-based (DXGI protocol: [0x01][4B w][4B h][JPEG...])
// Substitui o noVNC — sem dependência de RFB, funciona com nexus-screen.exe
function paginaViewer(token) {
  // wsPath: server-side; browser monta a URL completa com location.host
  const wsPath = `${BASE}/view?token=${encodeURIComponent(token)}`;

  return `<!doctype html><html lang="pt-br"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tela remota — Nexus RMM</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;background:#000;overflow:hidden;font-family:system-ui,sans-serif}
#status{position:fixed;top:8px;left:8px;z-index:20;font-size:12px;color:#fff;
  background:#000b;padding:5px 10px;border-radius:6px;pointer-events:none}
#tools{position:fixed;bottom:8px;left:50%;transform:translateX(-50%);z-index:20;
  display:flex;gap:6px;align-items:center;background:#000b;
  padding:5px 8px;border-radius:8px;flex-wrap:wrap;max-width:96vw}
#tools button,#tools select{font-size:11px;color:#cfe;background:#161616;
  border:1px solid #2a6;border-radius:6px;padding:4px 8px;cursor:pointer}
#wrap{position:relative;width:100vw;height:100vh;overflow:hidden;cursor:none}
#cv{position:absolute;top:0;left:0;image-rendering:pixelated}
#cursor{position:absolute;width:16px;height:16px;pointer-events:none;z-index:10;
  display:none;
  background:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'><path d='M1 1l7 14 2-5 5-2z' fill='white' stroke='black' stroke-width='1'/></svg>") no-repeat}
</style>
</head><body>
<div id="status">conectando…</div>
<div id="tools">
  <span id="grip" style="cursor:move;color:#789;padding:0 4px;user-select:none">⠿</span>
  <button id="bcad">Ctrl+Alt+Del</button>
  <button id="bwin">⊞ Win</button>
  <button id="batab">Alt+Tab</button>
  <button id="besc">Esc</button>
  <select id="bqual" title="Qualidade"><option value="40">⚡ Rápido</option><option value="65" selected>Equilibrado</option><option value="88">🔍 Nítido</option></select>
  <select id="bfps" title="FPS"><option value="15">15 fps</option><option value="30" selected>30 fps</option><option value="60">60 fps</option></select>
</div>
<div id="wrap"><canvas id="cv"></canvas><div id="cursor"></div></div>
<script>
// ── estado ────────────────────────────────────────────────────────────────────
let ws, cvW=0, cvH=0;
const st=document.getElementById('status');
const cv=document.getElementById('cv');
const ctx=cv.getContext('2d',{alpha:false});
const wrap=document.getElementById('wrap');
const cur=document.getElementById('cursor');

// ── WebSocket ─────────────────────────────────────────────────────────────────
function conectar(){
  ws=new WebSocket('wss://'+location.host+'${wsPath}');
  ws.binaryType='arraybuffer';
  let tentativas=0;
  ws.onopen=()=>{ tentativas=0; st.textContent='🟢 conectado'; setTimeout(()=>st.style.opacity=.2,2500); montarTools(); };
  ws.onclose=(e)=>{
    st.style.opacity=1;
    if(tentativas<20){tentativas++;st.textContent='🔄 reconectando… ('+tentativas+')';setTimeout(conectar,2000);}
    else st.textContent='🔴 sem conexão';
  };
  ws.onerror=()=>{};
  ws.onmessage=async(e)=>{
    if(!(e.data instanceof ArrayBuffer))return;
    const buf=new Uint8Array(e.data);
    if(buf[0]!==0x01)return;
    const w=buf[1]|(buf[2]<<8)|(buf[3]<<16)|(buf[4]<<24);
    const h=buf[5]|(buf[6]<<8)|(buf[7]<<16)|(buf[8]<<24);
    const jpegData=buf.slice(9);
    if(w!==cvW||h!==cvH){ cvW=w;cvH=h;redimensionar(); }
    const blob=new Blob([jpegData],{type:'image/jpeg'});
    try{
      const bmp=await createImageBitmap(blob);
      ctx.drawImage(bmp,0,0);
      bmp.close();
    }catch{}
  };
}

// ── redimensionar canvas ──────────────────────────────────────────────────────
function redimensionar(){
  cv.width=cvW; cv.height=cvH;
  const s=Math.min(window.innerWidth/cvW,window.innerHeight/cvH);
  cv.style.width=(cvW*s)+'px'; cv.style.height=(cvH*s)+'px';
  cv.style.left=((window.innerWidth-cvW*s)/2)+'px';
  cv.style.top=((window.innerHeight-cvH*s)/2)+'px';
}
window.addEventListener('resize',()=>{ if(cvW) redimensionar(); });

// ── enviar comando ────────────────────────────────────────────────────────────
function send(obj){ if(ws&&ws.readyState===1)ws.send(JSON.stringify(obj)); }

// ── input (pointer events — funciona com mouse E touch/stylus) ────────────────
let prevButtons=0;
function normCoords(e){
  const r=cv.getBoundingClientRect();
  return{x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),
         y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};
}
function moveCursor(e){
  const r=cv.getBoundingClientRect();
  cur.style.display='block';
  cur.style.left=(e.clientX-r.left-1)+'px';
  cur.style.top=(e.clientY-r.top-1)+'px';
}
// Pointer Events API — unifica mouse + touch + stylus num único handler
wrap.style.touchAction='none'; // evita scroll do browser ao tocar
wrap.addEventListener('contextmenu',e=>e.preventDefault());
wrap.addEventListener('pointermove',e=>{
  moveCursor(e);
  const{x,y}=normCoords(e);
  send({cmd:'mouse',x,y,buttons:prevButtons});
});
wrap.addEventListener('pointerdown',e=>{
  e.preventDefault();
  wrap.setPointerCapture(e.pointerId); // mantém captura mesmo saindo do elemento
  // touch (pointerType==='touch') sempre usa botão esquerdo (button 0)
  const btn=e.pointerType==='touch'?0:(e.button===0?0:e.button===2?1:2);
  prevButtons|=(btn===0?1:btn===1?2:4);
  const{x,y}=normCoords(e);
  send({cmd:'mouse',x,y,buttons:prevButtons});
});
wrap.addEventListener('pointerup',e=>{
  const btn=e.pointerType==='touch'?0:(e.button===0?0:e.button===2?1:2);
  prevButtons&=~(btn===0?1:btn===1?2:4);
  const{x,y}=normCoords(e);
  send({cmd:'mouse',x,y,buttons:prevButtons});
  wrap.releasePointerCapture(e.pointerId);
});
wrap.addEventListener('pointerleave',e=>{
  if(e.pointerType!=='touch') cur.style.display='none';
  if(prevButtons){send({cmd:'mouseup',buttons:prevButtons});prevButtons=0;}
});
wrap.addEventListener('wheel',e=>{
  e.preventDefault();
  const{x,y}=normCoords(e);
  send({cmd:'scroll',x,y,delta:Math.sign(e.deltaY)*Math.min(Math.abs(e.deltaY)/100,3)});
},{passive:false});

// ── teclado ───────────────────────────────────────────────────────────────────
// Mapeamento code → VK do Windows
const VK={
  'KeyA':65,'KeyB':66,'KeyC':67,'KeyD':68,'KeyE':69,'KeyF':70,'KeyG':71,'KeyH':72,
  'KeyI':73,'KeyJ':74,'KeyK':75,'KeyL':76,'KeyM':77,'KeyN':78,'KeyO':79,'KeyP':80,
  'KeyQ':81,'KeyR':82,'KeyS':83,'KeyT':84,'KeyU':85,'KeyV':86,'KeyW':87,'KeyX':88,
  'KeyY':89,'KeyZ':90,
  'Digit0':48,'Digit1':49,'Digit2':50,'Digit3':51,'Digit4':52,
  'Digit5':53,'Digit6':54,'Digit7':55,'Digit8':56,'Digit9':57,
  'Numpad0':96,'Numpad1':97,'Numpad2':98,'Numpad3':99,'Numpad4':100,
  'Numpad5':101,'Numpad6':102,'Numpad7':103,'Numpad8':104,'Numpad9':105,
  'NumpadAdd':107,'NumpadSubtract':109,'NumpadMultiply':106,'NumpadDivide':111,
  'NumpadDecimal':110,'NumpadEnter':13,
  'F1':112,'F2':113,'F3':114,'F4':115,'F5':116,'F6':117,
  'F7':118,'F8':119,'F9':120,'F10':121,'F11':122,'F12':123,
  'Enter':13,'Escape':27,'Backspace':8,'Tab':9,'Space':32,'Delete':46,'Insert':45,
  'Home':36,'End':35,'PageUp':33,'PageDown':34,
  'ArrowLeft':37,'ArrowUp':38,'ArrowRight':39,'ArrowDown':40,
  'ShiftLeft':16,'ShiftRight':16,'ControlLeft':17,'ControlRight':17,
  'AltLeft':18,'AltRight':18,'MetaLeft':91,'MetaRight':92,
  'CapsLock':20,'NumLock':144,'ScrollLock':145,'PrintScreen':44,'Pause':19,
  'Minus':189,'Equal':187,'BracketLeft':219,'BracketRight':221,
  'Backslash':220,'Semicolon':186,'Quote':222,'Comma':188,'Period':190,'Slash':191,
  'Backquote':192,
};
window.addEventListener('keydown',e=>{
  e.preventDefault();
  const vk=VK[e.code];
  if(vk) send({cmd:'key',vk,down:true});
});
window.addEventListener('keyup',e=>{
  e.preventDefault();
  const vk=VK[e.code];
  if(vk) send({cmd:'key',vk,down:false});
});

// ── toolbar ───────────────────────────────────────────────────────────────────
function montarTools(){
  document.getElementById('bcad').onclick=()=>{
    send({cmd:'key',vk:17,down:true});
    send({cmd:'key',vk:18,down:true});
    send({cmd:'key',vk:46,down:true});
    send({cmd:'key',vk:46,down:false});
    send({cmd:'key',vk:18,down:false});
    send({cmd:'key',vk:17,down:false});
  };
  document.getElementById('bwin').onclick=()=>{ send({cmd:'key',vk:91,down:true}); send({cmd:'key',vk:91,down:false}); };
  document.getElementById('batab').onclick=()=>{
    send({cmd:'key',vk:18,down:true});
    send({cmd:'key',vk:9,down:true});
    send({cmd:'key',vk:9,down:false});
    send({cmd:'key',vk:18,down:false});
  };
  document.getElementById('besc').onclick=()=>{ send({cmd:'key',vk:27,down:true}); send({cmd:'key',vk:27,down:false}); };
  document.getElementById('bqual').onchange=e=>send({cmd:'qualidade',q:Number(e.target.value)});
  document.getElementById('bfps').onchange=e=>send({cmd:'fps',v:Number(e.target.value)});
  // arrastar toolbar
  const tools=document.getElementById('tools');
  const grip=document.getElementById('grip');
  grip.onmousedown=ev=>{
    ev.preventDefault();
    const r=tools.getBoundingClientRect();
    const dx=ev.clientX-r.left,dy=ev.clientY-r.top;
    const mv=e=>{ tools.style.left=Math.max(0,e.clientX-dx)+'px'; tools.style.top=Math.max(0,e.clientY-dy)+'px'; tools.style.bottom='auto'; tools.style.transform='none'; };
    const up=()=>{ removeEventListener('mousemove',mv); removeEventListener('mouseup',up); };
    addEventListener('mousemove',mv); addEventListener('mouseup',up);
  };
}


conectar();
</script>
</body></html>`;
}


// --- HTTP ------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;

  if (p === BASE || p === BASE + "/") { res.writeHead(200, { "Content-Type": MIME[".html"] }); res.end(paginaLogin()); return; }

  if (p === BASE + "/login" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      const senha = new URLSearchParams(body).get("senha") || "";
      const ok = senha.length === VIEW_PASSWORD.length &&
        crypto.timingSafeEqual(Buffer.from(senha), Buffer.from(VIEW_PASSWORD));
      if (!ok) { res.writeHead(401, { "Content-Type": MIME[".html"] }); res.end(paginaLogin("Senha incorreta.")); return; }
      const t = novoTokenView();
      res.writeHead(302, { Location: `${BASE}/viewer?token=${t}` }); res.end();
    });
    return;
  }

  if (p === BASE + "/viewer") {
    const t = u.searchParams.get("token") || "";
    if (!viewerAutorizado(t)) { res.writeHead(302, { Location: BASE + "/" }); res.end(); return; }
    // Exige sessão do painel logada (mesmo tenant): URL vazada sozinha não abre.
    if (!sessaoPainelOk(req.headers.cookie, t)) {
      res.writeHead(403, { "Content-Type": MIME[".html"] });
      res.end("<body style='font-family:system-ui;background:#0a0a0a;color:#eee;padding:40px'><h2>🔒 Acesso negado</h2><p>Você precisa estar logado no painel Nexus RMM (na mesma conta) para abrir esta tela. Um link de acesso remoto sozinho não funciona — é proteção contra vazamento.</p></body>");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[".html"] }); res.end(paginaViewer(t)); return;
  }

  if (p.startsWith(BASE + "/novnc/")) {
    const rel = p.slice((BASE + "/novnc/").length);
    const alvo = path.normalize(path.join(NOVNC_DIR, rel));
    if (!alvo.startsWith(path.normalize(NOVNC_DIR))) { res.writeHead(403).end(); return; }
    servirArquivo(res, alvo); return;
  }

  if (p === BASE + "/health") { res.writeHead(200).end("ok"); return; }

  res.writeHead(404).end("não encontrado");
});

// --- WebSockets ------------------------------------------------------------
const wssAgent = new WebSocketServer({ noServer: true });
const wssView = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === BASE + "/agent") {
    const token = u.searchParams.get("token") || "";
    const okStatic = token.length === AGENT_TOKEN.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(AGENT_TOKEN));
    const grant = okStatic ? null : verifyAgentGrant(token);
    if (!okStatic && !grant) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return;
    }
    const machineId = u.searchParams.get("machineId") || (grant && grant.machineId) || "default";
    const hostname = u.searchParams.get("hostname") || "";
    wssAgent.handleUpgrade(req, socket, head, (ws) => {
      ws.machineId = machineId;
      ws.hostname = hostname;
      wssAgent.emit("connection", ws);
    });
  } else if (u.pathname === BASE + "/view") {
    const token = u.searchParams.get("token") || "";
    if (!viewerAutorizado(token)) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
    if (!sessaoPainelOk(req.headers.cookie, token)) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return; }
    
    // Grant vale pela validade inteira (60s), permitindo reconexões do noVNC no navegador.
    // A segurança vem da assinatura + TTL curto + escopo por máquina (não precisa ser uso único).

    const dados = extrairDadosDoToken(token);
    wssView.handleUpgrade(req, socket, head, (ws) => {
      ws.machineId = dados.machineId;
      ws.hostname = dados.hostname;
      wssView.emit("connection", ws);
    });
  } else {
    socket.destroy();
  }
});

wssAgent.on("connection", (ws) => {
  const machineId = ws.machineId || "default";
  const hostname = (ws.hostname || "").toLowerCase();

  // Salva no Map de IDs
  const antigoId = agentSocks.get(machineId);
  if (antigoId) { try { antigoId.close(); } catch {} }
  agentSocks.set(machineId, ws);

  // Salva no Map de Hostnames
  if (hostname) {
    const antigoHost = agentSocksByHostname.get(hostname);
    if (antigoHost) { try { antigoHost.close(); } catch {} }
    agentSocksByHostname.set(hostname, ws);
  }

  console.log(`[agent] conectado. ID: ${machineId}, Host: ${ws.hostname || "desconhecido"}`);
  ws.binaryType = "nodebuffer";

  ws.on("message", (data, isBinary) => {
    const vSock = ws.associatedViewer || viewerSocks.get(machineId) || (hostname ? viewerSocks.get(hostname) : null);
    if (isBinary && vSock && vSock.readyState === vSock.OPEN) vSock.send(data);
    else if (!isBinary) console.log(`[agent ${machineId}] msg:`, data.toString().slice(0, 200));
  });

  ws.on("close", () => {
    console.log(`[agent ${machineId}] desconectado`);
    if (agentSocks.get(machineId) === ws) agentSocks.delete(machineId);
    if (hostname && agentSocksByHostname.get(hostname) === ws) agentSocksByHostname.delete(hostname);
    const vSock = ws.associatedViewer;
    if (vSock) {
      try { vSock.close(); } catch {}
      vSock.associatedAgent = null;
    }
  });
  ws.on("error", () => {});
});

wssView.on("connection", async (ws) => {
  const machineId = ws.machineId || "default";
  const hostname = (ws.hostname || "").toLowerCase();

  // Espera o agente aparecer (ele leva alguns segundos para subir o TightVNC + túnel
  // depois do clique). Em vez de cortar na hora, aguarda até ~45s (importante no primeiro setup).
  let aSock = null;
  for (let i = 0; i < 225; i++) {
    aSock = agentSocks.get(machineId);
    if ((!aSock || aSock.readyState !== aSock.OPEN) && hostname) {
      aSock = agentSocksByHostname.get(hostname);
    }
    if (aSock && aSock.readyState === aSock.OPEN) break;
    if (ws.readyState !== ws.OPEN) return; // viewer desistiu
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!aSock || aSock.readyState !== aSock.OPEN) {
    ws.close(1011, "agente offline"); return;
  }

  // 1 sessão por máquina: se já existe um viewer ATIVO, recusa a NOVA (não derruba a sua).
  const antigo = viewerSocks.get(machineId);
  if (antigo && antigo !== ws && antigo.readyState === antigo.OPEN) {
    console.log(`[view] sessão já ativa para ${machineId} — recusando nova conexão.`);
    try { ws.close(4001, "Já existe uma sessão de tela ativa para esta máquina."); } catch {}
    return;
  }

  // Vincula os sockets diretamente de forma cruzada
  ws.associatedAgent = aSock;
  aSock.associatedViewer = ws;
  viewerSocks.set(machineId, ws);
  if (hostname) {
    viewerSocks.set(hostname, ws);
  }

  ws.binaryType = "nodebuffer";
  console.log(`[view] conectado para maquina ${machineId} (agente ID: ${aSock.machineId}, Host: ${aSock.hostname || "default"}) → abrindo tunel`);
  try { aSock.send(JSON.stringify({ type: "open" })); } catch {}

  ws.on("message", (data, isBinary) => {
    // Repassa TANTO mensagens binárias (frames JPEG) QUANTO texto (JSON de mouse/teclado/monitor)
    if (ws.associatedAgent && ws.associatedAgent.readyState === ws.associatedAgent.OPEN) {
      ws.associatedAgent.send(data, { binary: isBinary });
    }
  });

  ws.on("close", () => {
    console.log(`[view] desconectado de maquina ${machineId} → fechando tunel`);
    if (viewerSocks.get(machineId) === ws) viewerSocks.delete(machineId);
    if (hostname && viewerSocks.get(hostname) === ws) viewerSocks.delete(hostname);
    if (ws.associatedAgent && ws.associatedAgent.readyState === ws.associatedAgent.OPEN) {
      try { ws.associatedAgent.send(JSON.stringify({ type: "close" })); } catch {}
      ws.associatedAgent.associatedViewer = null;
    }
  });
  ws.on("error", () => {});
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✓ relay do spike ouvindo em :${PORT} (base ${BASE})`);
});
