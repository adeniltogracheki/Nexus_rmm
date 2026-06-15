// const VERSAO = "0.6.3";
// ============================================================================
//  Nexus RMM — AGENTE DE PRODUÇÃO (presença via mTLS + Serviços do Windows)
//  1ª execução: enrolla (gera par RSA, troca por certificado mTLS via token).
//  Depois: conecta no gateway (8443, mTLS) e envia heartbeat → máquina ONLINE.
//  Estado (cert/chave) salvo localmente; nada de senha em código.
// ============================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { io } from "socket.io-client";
import net from "node:net";
import WebSocket from "ws";
import { Worker } from "node:worker_threads";

// Resolve o path do módulo node-pty sem carregá-lo no thread principal.
// PTY é executado em worker_threads para não bloquear o event loop mesmo em Session 0
// (contexto de serviço Windows onde ConPTY pode demorar até 30s para inicializar).
let ptyModulePath = null;
try {
  const _require = createRequire(import.meta.url);
  ptyModulePath = _require.resolve("@homebridge/node-pty-prebuilt-multiarch");
} catch (_e) {
  // node-pty não instalado — terminal usará modo pipe (spawn)
}

// Código do worker thread que executa node-pty de forma isolada.
// Roda como CJS (package.json do agente tem "type":"commonjs") — require() disponível.
const PTY_WORKER_CODE = `
const { workerData, parentPort } = require('worker_threads');
try {
  const pty = require(workerData.ptyModulePath);
  const proc = pty.spawn(workerData.cmd, workerData.args, workerData.opts);
  parentPort.postMessage({ type: 'ready' });
  proc.onData(function(d) { parentPort.postMessage({ type: 'data', data: d }); });
  proc.onExit(function(info) { parentPort.postMessage({ type: 'exit', code: info.exitCode }); });
  parentPort.on('message', function(msg) {
    try {
      if (msg.type === 'write') proc.write(msg.data);
      else if (msg.type === 'resize') proc.resize(msg.cols, msg.rows);
      else if (msg.type === 'kill') { try { proc.kill(); } catch(e) {} process.exit(0); }
    } catch(e) {}
  });
} catch(err) {
  parentPort.postMessage({ type: 'error', message: err.message });
}
`;

const _execRaw = promisify(exec);
// Sempre oculta a janela do processo (senão pisca uma tela preta a cada coleta/comando).
const execAsync = (cmd, opts = {}) => _execRaw(cmd, { windowsHide: true, ...opts });
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = process.env.AGENT_STATE || path.join(__dirname, "agent-state.json");
// Watchdog: lista de serviços vigiados (persistida, sobrevive restart/auto-update).
const WATCHDOG_FILE = path.join(path.dirname(STATE_FILE), "watchdogs.json");
function carregarWatchdogs() {
  try { return new Set(JSON.parse(fs.readFileSync(WATCHDOG_FILE, "utf8"))); } catch { return new Set(); }
}
function salvarWatchdogs(set) {
  try { fs.writeFileSync(WATCHDOG_FILE, JSON.stringify([...set]), { mode: 0o600 }); } catch {}
}
const API_URL = process.env.NEXUS_API_URL || "https://rmm.gmtec.tec.br";
const GATEWAY_URL = process.env.NEXUS_GATEWAY_URL || "wss://rmm.gmtec.tec.br:8443";
const ENROLL_TOKEN = process.env.NEXUS_ENROLL_TOKEN || process.argv.find(arg => arg.startsWith("--token="))?.split("=")[1] || "";
const VERSAO = "0.6.3";
const HEARTBEAT_MS = 25_000;

// Helper para resolver o caminho do powershell.exe de forma robusta no Windows
function obterPowershellCmd() {
  if (os.platform() !== "win32") return "powershell";
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const standardPath = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (fs.existsSync(standardPath)) {
    return `"${standardPath}"`;
  }
  return "powershell";
}

// Helper para resolver o caminho do cmd.exe de forma robusta no Windows
function obterCmdPath() {
  if (os.platform() !== "win32") return "cmd";
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const standardPath = path.join(systemRoot, "System32", "cmd.exe");
  if (fs.existsSync(standardPath)) {
    return standardPath;
  }
  return "cmd.exe";
}

// Detecta se o agente está rodando em Session 0 (serviço SYSTEM no Windows).
// ConPTY e winpty (node-pty) falham em Session 0 porque não há desktop interativo.
// Neste caso, pula o PTY e usa spawn pipe mode diretamente.
function isSession0Windows() {
  if (os.platform() !== "win32") return false;
  const username = (process.env.USERNAME || "").toLowerCase().trim();
  const sessionName = (process.env.SESSIONNAME || "").toLowerCase().trim();
  // SYSTEM: USERNAME='system', SESSIONNAME='services' (NSSM) ou vazio (Scheduled Task)
  return username === "system" || sessionName === "services" || !sessionName;
}

// Helper para gerar o payload de assinatura igual ao servidor
function obterPayloadAssinatura(cmd) {
  if (cmd.type === "service.action") {
    return [
      cmd.commandId,
      cmd.machineId,
      cmd.issuedAt.toString(),
      cmd.expiresAt.toString(),
      cmd.type,
      cmd.service,
      cmd.action,
      cmd.startupType ?? "",
    ].join("|");
  } else if (cmd.type === "service.set-watchdog") {
    return [
      cmd.commandId,
      cmd.machineId,
      cmd.issuedAt.toString(),
      cmd.expiresAt.toString(),
      cmd.type,
      cmd.service,
      cmd.enabled.toString(),
    ].join("|");
  } else if (cmd.type === "pty.input") {
    return [
      cmd.commandId,
      cmd.machineId,
      cmd.issuedAt.toString(),
      cmd.expiresAt.toString(),
      cmd.type,
      cmd.sessionId,
      cmd.data,
    ].join("|");
  } else if (cmd.type === "shell.run") {
    return [
      cmd.commandId,
      cmd.machineId,
      cmd.issuedAt.toString(),
      cmd.expiresAt.toString(),
      cmd.type,
      cmd.shell,
      cmd.command,
    ].join("|");
  } else if (cmd.type === "file.read") {
    return [cmd.commandId, cmd.machineId, cmd.issuedAt.toString(), cmd.expiresAt.toString(), cmd.type, cmd.path].join("|");
  } else if (cmd.type === "file.write") {
    return [cmd.commandId, cmd.machineId, cmd.issuedAt.toString(), cmd.expiresAt.toString(), cmd.type, cmd.path, cmd.conteudo].join("|");
  }
  throw new Error("Tipo de comando desconhecido para assinatura");
}

function verificarAssinatura(cmd, caCertPem) {
  try {
    const { signature, ...cmdWithoutSignature } = cmd;
    const payload = obterPayloadAssinatura(cmdWithoutSignature);
    const verify = crypto.createVerify("SHA256");
    verify.update(payload);
    return verify.verify(caCertPem, signature, "hex");
  } catch (err) {
    console.error("Falha ao verificar assinatura:", err.message);
    return false;
  }
}

async function obterServicosWindows() {
  if (os.platform() === "linux") {
    // Serviços do systemd (systemctl).
    try {
      const { stdout } = await execAsync(
        "systemctl list-units --type=service --all --no-legend --no-pager 2>/dev/null",
        { maxBuffer: 20 * 1024 * 1024 },
      );
      const svc = [];
      for (const raw of stdout.split("\n")) {
        const l = raw.replace(/^[●*]\s*/, "").trim();
        if (!l) continue;
        const cols = l.split(/\s+/);
        if (cols.length < 4 || !cols[0].endsWith(".service")) continue;
        const sub = cols[3];
        svc.push({
          Name: cols[0].replace(/\.service$/, ""),
          DisplayName: cols.slice(4).join(" ") || cols[0],
          Status: sub === "running" ? "Running" : "Stopped",
          StartType: "Automatic",
        });
      }
      return svc;
    } catch (e) {
      console.error("Erro ao listar serviços (systemctl):", e.message);
      return [];
    }
  }
  if (os.platform() !== "win32") return [];
  try {
    // Roda via arquivo .ps1 temporário (evita o escaping frágil de aspas/backticks no cmd.exe).
    const script =
      "try{$OutputEncoding=[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false}catch{}; " +
      "Get-Service | Select-Object Name, DisplayName, " +
      "@{N='Status';E={$_.Status.ToString()}}, @{N='StartType';E={$_.StartType.ToString()}} | " +
      "ConvertTo-Json -Compress";
    const tmp = path.join(os.tmpdir(), `nexus-svc-${Date.now()}.ps1`);
    fs.writeFileSync(tmp, script, "utf8");
    let stdout = "";
    const psCmd = obterPowershellCmd();
    try {
      ({ stdout } = await execAsync(
        `${psCmd} -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`,
        { maxBuffer: 20 * 1024 * 1024 },
      ));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    if (!stdout || stdout.trim() === "") return [];
    const list = JSON.parse(stdout);
    return Array.isArray(list) ? list : [list];
  } catch (err) {
    console.error("Erro ao obter serviços Windows:", err.message);
    return [];
  }
}

async function obterInventarioSistema() {
  const capturadoEm = Date.now();
  
  // 1. Rede via Node.js (nativa e rápida)
  const interfaces = os.networkInterfaces();
  const rede = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    const ips = [];
    let mac = "";
    let internal = false;
    for (const a of addrs) {
      if (a.internal) internal = true;
      ips.push(a.address);
      if (a.mac && a.mac !== '00:00:00:00:00:00') {
        mac = a.mac;
      }
    }
    if (!internal && ips.length > 0) {
      rede.push({
        interface: name,
        mac: mac || "00:00:00:00:00:00",
        ips
      });
    }
  }

  if (os.platform() === "linux") {
    const sh = async (c) => { try { return (await execAsync(c, { timeout: 10000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim(); } catch { return ""; } };
    const cpus = os.cpus();
    const discos = [];
    const dfOut = await sh("df -B1 -x tmpfs -x devtmpfs -x overlay -x squashfs --output=target,size,avail 2>/dev/null | tail -n +2");
    for (const l of dfOut.split("\n")) {
      const p = l.trim().split(/\s+/);
      if (p.length >= 3 && p[0].startsWith("/")) discos.push({ caminho: p[0], tamanhoBytes: Number(p[1]) || 0, livreBytes: Number(p[2]) || 0 });
    }
    const osRelease = await sh("cat /etc/os-release 2>/dev/null");
    const pretty = (osRelease.match(/PRETTY_NAME="?([^"\n]+)"?/) || [])[1] || "Linux";
    const vendor = await sh("cat /sys/class/dmi/id/sys_vendor 2>/dev/null");
    const product = await sh("cat /sys/class/dmi/id/product_name 2>/dev/null");
    // Tipo de dispositivo via DMI chassis_type (decimal)
    // https://www.dmtf.org/sites/default/files/standards/documents/DSP0134_3.6.0.pdf §7.4.1
    const CHASSIS_NOTEBOOK_LINUX = new Set([8, 9, 10, 11, 14, 30, 31, 32]); // portable/laptop/notebook/handheld/sub-notebook/tablet/convertible/detachable
    const CHASSIS_SERVER_LINUX   = new Set([17, 23, 28, 29]);
    const chassisTypeStr = await sh("cat /sys/class/dmi/id/chassis_type 2>/dev/null");
    const chassisType = parseInt(chassisTypeStr, 10) || 0;
    const tipoMaquinaLinux = CHASSIS_NOTEBOOK_LINUX.has(chassisType) ? 'notebook'
                           : CHASSIS_SERVER_LINUX.has(chassisType)   ? 'servidor'
                           : 'pc';
    const macAddressLinux = rede.find(r =>
      r.mac && r.mac !== '00:00:00:00:00:00' &&
      !/virtual|vmware|vbox|docker|br-|veth|lo/i.test(r.interface)
    )?.mac ?? rede.find(r => r.mac && r.mac !== '00:00:00:00:00:00')?.mac ?? null;
    let software = [];
    const dpkg = await sh("dpkg-query -W -f='${Package}\\t${Version}\\n' 2>/dev/null | head -500");
    const fonte = dpkg || (await sh("rpm -qa --qf '%{NAME}\\t%{VERSION}\\n' 2>/dev/null | head -500"));
    if (fonte) software = fonte.split("\n").filter(Boolean).map((l) => { const [nome, versao] = l.split("\t"); return { nome, versao: versao || null, fornecedor: null, dataInstalacao: null }; });
    return {
      machineId: null,
      capturadoEm,
      hardware: {
        cpu: { modelo: (cpus[0]?.model || "CPU").trim(), cores: cpus.length, threads: cpus.length },
        ram: { totalBytes: os.totalmem() },
        discos,
        fabricante: vendor || "—",
        modeloPlaca: product || "—",
      },
      so: { nome: pretty, versao: os.release(), arquitetura: os.arch(), dataInstalacao: null, bootTime: new Date(Date.now() - os.uptime() * 1000).toISOString() },
      rede,
      software,
      tipoMaquina: tipoMaquinaLinux,
      macAddress: macAddressLinux,
    };
  }
  if (os.platform() === "darwin") {
    const sh = async (c) => { try { return (await execAsync(c, { timeout: 10000 })).stdout.trim(); } catch { return ""; } };
    const cpus = os.cpus();
    // Discos via df
    const discos = [];
    const dfOut = await sh("df -k 2>/dev/null | grep -v tmpfs | grep '^/'");
    for (const l of dfOut.split("\n")) {
      const p = l.trim().split(/\s+/);
      if (p.length >= 4 && p[0].startsWith("/")) {
        const total = Number(p[1]) * 1024;
        const avail = Number(p[3]) * 1024;
        if (total > 0) discos.push({ caminho: p[8] || p[0], tamanhoBytes: total, livreBytes: avail });
      }
    }
    // Modelo do Mac (ex: "MacBook Pro (14-inch, 2021)" ou "Mac mini")
    const hwModel = await sh("sysctl -n hw.model 2>/dev/null");
    // Tipo: MacBook → notebook; MacPro|Mac Pro → servidor; outros → pc
    const tipoMaquinaMac = /macbook/i.test(hwModel) ? 'notebook'
                         : /macpro|mac pro|xserve/i.test(hwModel) ? 'servidor'
                         : 'pc';
    // MAC address via ifconfig en0
    const ifcOut = await sh("ifconfig en0 2>/dev/null | awk '/ether/ {print $2}'");
    const macAddressMac = ifcOut && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(ifcOut) ? ifcOut : null;
    // Software instalado (lista simplificada de /Applications)
    const appsOut = await sh("ls -1 /Applications 2>/dev/null | grep '\\.app$' | head -200");
    const software = appsOut
      ? appsOut.split("\n").filter(Boolean).map((n) => ({ nome: n.replace(/\.app$/, ""), versao: null, fornecedor: "Apple / App Store", dataInstalacao: null }))
      : [];
    // Versão do SO via sw_vers
    const swVers = await sh("sw_vers -productVersion 2>/dev/null");
    const soNome = await sh("sw_vers -productName 2>/dev/null") || "macOS";
    return {
      machineId: null,
      capturadoEm,
      hardware: {
        cpu: { modelo: (cpus[0]?.model || hwModel || "CPU").trim(), cores: cpus.length, threads: cpus.length },
        ram: { totalBytes: os.totalmem() },
        discos,
        fabricante: "Apple",
        modeloPlaca: hwModel || "Mac",
      },
      so: { nome: `${soNome} ${swVers}`.trim() || "macOS", versao: swVers || os.release(), arquitetura: os.arch(), dataInstalacao: null, bootTime: new Date(Date.now() - os.uptime() * 1000).toISOString() },
      rede,
      software,
      tipoMaquina: tipoMaquinaMac,
      macAddress: macAddressMac,
    };
  }

  if (os.platform() !== "win32") {
    return { machineId: null, capturadoEm, hardware: { cpu: { modelo: (os.cpus()[0]?.model || "CPU").trim(), cores: os.cpus().length, threads: os.cpus().length }, ram: { totalBytes: os.totalmem() }, discos: [], fabricante: "—", modeloPlaca: "—" }, so: { nome: os.type(), versao: os.release(), arquitetura: os.arch(), dataInstalacao: null, bootTime: new Date(Date.now() - os.uptime() * 1000).toISOString() }, rede, software: [] };
  }

  try {
    // No Windows: Executa todos os comandos de coleta em um único script PowerShell.
    // Isso evita o overhead de iniciar múltiplos processos powershell.exe e resolve
    // problemas com escaping complexo de cmd.exe/PowerShell.
    const script = [
      "try{$OutputEncoding=[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false}catch{}",
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$cpu = Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors",
      "$ram = Get-CimInstance Win32_ComputerSystem | Select-Object TotalPhysicalMemory, Manufacturer, Model",
      "$discos = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID, Size, FreeSpace",
      "$so = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSArchitecture, InstallDate, LastBootUpTime",
      "$software = @(Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | Select-Object DisplayName, DisplayVersion, Publisher, InstallDate)",
      // Chassis type para detectar notebook vs desktop vs servidor
      "$enclosure = Get-CimInstance Win32_SystemEnclosure | Select-Object ChassisTypes",
      "$result = @{ cpu = $cpu; ram = $ram; discos = $discos; so = $so; software = @($software); enclosure = $enclosure }",
      "$result | ConvertTo-Json -Depth 5 -Compress"
    ].join("\r\n");

    const tmp = path.join(os.tmpdir(), `nexus-inv-${Date.now()}.ps1`);
    fs.writeFileSync(tmp, script, "utf8");
    let stdout = "";
    const psCmd = obterPowershellCmd();
    try {
      ({ stdout } = await execAsync(
        `${psCmd} -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`,
        { maxBuffer: 40 * 1024 * 1024 }
      ));
    } finally {
      fs.rmSync(tmp, { force: true });
    }

    if (!stdout || stdout.trim() === "") throw new Error("Sem output do script de inventário");
    const raw = JSON.parse(stdout);
    
    // Processamento do processador (CPU)
    const cpuData = Array.isArray(raw.cpu) ? raw.cpu[0] : raw.cpu;
    const cpu = {
      modelo: cpuData?.Name?.trim() || "Unknown CPU",
      cores: Number(cpuData?.NumberOfCores) || 1,
      threads: Number(cpuData?.NumberOfLogicalProcessors) || 1
    };

    // Processamento da RAM e placa-mãe
    const ramData = Array.isArray(raw.ram) ? raw.ram[0] : raw.ram;
    const ramTotalBytes = Number(ramData?.TotalPhysicalMemory) || 0;
    const fabricante = ramData?.Manufacturer?.trim() || "Unknown";
    const modeloPlaca = ramData?.Model?.trim() || "Unknown";

    // Processamento dos discos lógicos
    const discosList = Array.isArray(raw.discos) ? raw.discos : (raw.discos ? [raw.discos] : []);
    const discos = discosList.map(d => ({
      caminho: d.DeviceID || "Unknown",
      tamanhoBytes: Number(d.Size) || 0,
      livreBytes: Number(d.FreeSpace) || 0
    }));

    // Processamento do Sistema Operacional (SO)
    const soData = Array.isArray(raw.so) ? raw.so[0] : raw.so;
    const so = {
      nome: soData?.Caption?.trim() || "Windows",
      versao: soData?.Version?.trim() || "Unknown",
      arquitetura: soData?.OSArchitecture?.trim() || "Unknown",
      dataInstalacao: soData?.InstallDate || null,
      bootTime: soData?.LastBootUpTime || null
    };

    // Processamento dos softwares instalados
    const softList = Array.isArray(raw.software) ? raw.software : (raw.software ? [raw.software] : []);
    const software = softList.map(s => ({
      nome: s.DisplayName?.trim() || "Unknown Software",
      versao: s.DisplayVersion?.toString().trim() || null,
      fornecedor: s.Publisher?.trim() || null,
      dataInstalacao: s.InstallDate?.toString().trim() || null
    }));

    // Tipo de dispositivo via chassis type (Win32_SystemEnclosure.ChassisTypes)
    // https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-systemenclosure
    const CHASSIS_NOTEBOOK = new Set([8, 9, 10, 11, 14, 18, 21]); // Portable/Laptop/Notebook/HandHeld/SubNotebook/Tablet/Convertible
    const CHASSIS_SERVER   = new Set([17, 23, 28, 29]);             // Rack/Blade/Tower Server
    const enclosureData = raw.enclosure;
    const chassisRaw = Array.isArray(enclosureData)
      ? (enclosureData[0]?.ChassisTypes ?? [])
      : (enclosureData?.ChassisTypes ?? []);
    const chassisTypes = (Array.isArray(chassisRaw) ? chassisRaw : [chassisRaw]).map(Number).filter(Boolean);
    const tipoMaquina = chassisTypes.some(t => CHASSIS_NOTEBOOK.has(t)) ? 'notebook'
                      : chassisTypes.some(t => CHASSIS_SERVER.has(t))   ? 'servidor'
                      : 'pc';

    // MAC address primário para Wake-on-LAN
    // Preferir adaptadores não-virtuais e não-loopback com MAC válido
    const macAddress = rede.find(r =>
      r.mac && r.mac !== '00:00:00:00:00:00' &&
      !/virtual|vmware|vbox|hyper-v|loopback/i.test(r.interface)
    )?.mac ?? rede.find(r => r.mac && r.mac !== '00:00:00:00:00:00')?.mac ?? null;

    return {
      machineId: null,
      capturadoEm,
      hardware: {
        cpu,
        ram: { totalBytes: ramTotalBytes },
        discos,
        fabricante,
        modeloPlaca
      },
      so,
      rede,
      software,
      tipoMaquina,
      macAddress,
    };

  } catch (err) {
    console.error("Erro geral na coleta do inventário:", err.message);
    return {
      machineId: null,
      capturadoEm,
      hardware: {
        cpu: { modelo: "Unknown", cores: 1, threads: 1 },
        ram: { totalBytes: 0 },
        discos: []
      },
      so: { nome: "Windows (Erro)", versao: "Unknown", arquitetura: "Unknown" },
      rede,
      software: []
    };
  }
}

async function executarAcaoServico(service, action, startupType) {
  if (os.platform() === "linux") {
    const safe = String(service).replace(/[^\w.@-]/g, "");
    if (action === "START") await execAsync(`systemctl start ${safe}`);
    else if (action === "STOP") await execAsync(`systemctl stop ${safe}`);
    else if (action === "RESTART") await execAsync(`systemctl restart ${safe}`);
    else if (action === "CHANGE_TYPE") {
      const en = startupType === "Disabled" ? "disable" : "enable";
      await execAsync(`systemctl ${en} ${safe}`);
    } else throw new Error(`Ação desconhecida: ${action}`);
    return;
  }
  if (os.platform() !== "win32") {
    console.log(`[Mock] ${action} em ${service}`);
    return;
  }
  let cmd = "";
  const psCmd = obterPowershellCmd();
  if (action === "START") {
    cmd = `${psCmd} -Command "Start-Service -Name '${service}'"`;
  } else if (action === "STOP") {
    cmd = `${psCmd} -Command "Stop-Service -Name '${service}' -Force"`;
  } else if (action === "RESTART") {
    cmd = `${psCmd} -Command "Restart-Service -Name '${service}' -Force"`;
  } else if (action === "CHANGE_TYPE") {
    if (!startupType) throw new Error("startupType é obrigatório para CHANGE_TYPE");
    cmd = `${psCmd} -Command "Set-Service -Name '${service}' -StartupType '${startupType}'"`;
  } else {
    throw new Error(`Ação desconhecida: ${action}`);
  }
  await execAsync(cmd);
}

async function obterBiosUuid() {
  if (os.platform() !== "win32") {
    try {
      if (fs.existsSync("/etc/machine-id")) {
        const id = fs.readFileSync("/etc/machine-id", "utf8").trim();
        if (id) return id;
      }
      if (fs.existsSync("/var/lib/dbus/machine-id")) {
        const id = fs.readFileSync("/var/lib/dbus/machine-id", "utf8").trim();
        if (id) return id;
      }
      if (fs.existsSync("/sys/class/dmi/id/product_uuid")) {
        const uuid = fs.readFileSync("/sys/class/dmi/id/product_uuid", "utf8").trim();
        if (uuid) return uuid;
      }
    } catch (e) {
      console.warn("Erro ao ler identificadores no Linux:", e.message);
    }
    return `MOCK-${crypto.createHash("md5").update(os.hostname()).digest("hex")}`;
  }

  // No Windows:
  // 1. Tentar UUID da BIOS (pode exigir privilégio elevado dependendo da máquina)
  const psCmd = obterPowershellCmd();
  try {
    const { stdout } = await execAsync(`${psCmd} -Command "(Get-CimInstance Win32_ComputerSystemProduct).UUID"`);
    if (stdout && stdout.trim() !== "" && stdout.trim() !== "00000000-0000-0000-0000-000000000000" && stdout.trim().toUpperCase() !== "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF") {
      return stdout.trim();
    }
  } catch (err) {
    console.warn("Erro ao obter UUID da BIOS via Get-CimInstance:", err.message);
  }

  try {
    const { stdout } = await execAsync("wmic csproduct get uuid");
    const lines = stdout.split("\n").map(l => l.trim()).filter(l => l && l.toLowerCase() !== "uuid");
    if (lines.length > 0 && lines[0] && lines[0] !== "00000000-0000-0000-0000-000000000000" && lines[0].toUpperCase() !== "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF") {
      return lines[0];
    }
  } catch (err) {
    console.warn("Erro ao obter UUID da BIOS via wmic:", err.message);
  }

  // 2. Fallback: MachineGuid do Registro do Windows (Não exige privilégios de administrador)
  try {
    const { stdout } = await execAsync(`${psCmd} -Command "(Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid"`);
    if (stdout && stdout.trim() !== "") {
      return stdout.trim();
    }
  } catch (err) {
    console.error("Erro ao obter MachineGuid do registro do Windows:", err.message);
  }

  return null;
}

async function enroll() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const hostname = os.hostname();
  const soVersao = `${os.type()} ${os.release()}`;
  const biosUuid = await obterBiosUuid();
  const res = await fetch(`${API_URL}/api/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: ENROLL_TOKEN, hostname, chavePublicaPem: publicKey, soVersao: soVersao || undefined, versaoAgente: VERSAO, biosUuid: biosUuid || undefined }),
  });
  if (!res.ok) throw new Error(`enroll falhou (${res.status}): ${await res.text()}`);
  const { machineId, certificadoClientePem, certificadoCaPem } = await res.json();
  const state = { machineId, hostname, key: privateKey, cert: certificadoClientePem, ca: certificadoCaPem };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  console.log("✓ máquina cadastrada. machineId:", machineId);
  return state;
}

async function obterEstado() {
  if (fs.existsSync(STATE_FILE)) {
    console.log("• estado encontrado, reutilizando certificado.");
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  }
  if (!ENROLL_TOKEN) throw new Error("primeira execução: defina NEXUS_ENROLL_TOKEN (token do painel).");
  console.log("• primeira execução: cadastrando no servidor…");
  return enroll();
}

function compararVersoes(v1, v2) {
  const parts1 = v1.split(".").map(Number);
  const parts2 = v2.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

let _atualizandoAgente = false; // lock global: evita chamadas concorrentes de update
async function executarAutoUpdate(url, novaVersao) {
  if (compararVersoes(novaVersao, VERSAO) <= 0) {
    console.log(`[update] Versão disponível (${novaVersao}) é menor ou igual à versão atual (${VERSAO}). Abortando.`);
    return;
  }

  if (_atualizandoAgente) {
    console.log(`[update] Atualização para ${novaVersao} já em andamento — ignorando chamada duplicada.`);
    return;
  }
  _atualizandoAgente = true;

  // Se há sessão de tela ativa, encerrar graciosamente antes de atualizar
  if (telaWs && telaWs.readyState === WebSocket.OPEN) {
    console.log(`[update] Sessão de tela ativa — encerrando relay para aplicar atualização ${novaVersao}`);
    try { telaWs.close(); } catch {}
    telaWs = null;
    if (telaHelper) { try { telaHelper.close(); } catch {}; telaHelper = null; }
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`[update] Baixando versão ${novaVersao} de ${url}...`);
  // Timeout de 30s no download para não travar indefinidamente
  const ctrl = new AbortController();
  const fetchTimer = setTimeout(() => ctrl.abort(), 30_000);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(fetchTimer);
  }
  if (!res.ok) {
    throw new Error(`Erro ao baixar atualização (${res.status}): ${await res.text()}`);
  }
  const novoCodigo = await res.text();

  // Validar nova versão no código baixado
  const match = novoCodigo.match(/(?:const|var|let)\s+VERSAO\s*=\s*["']([^"']+)["']/);
  const versaoDetectada = match ? match[1] : null;

  if (!versaoDetectada) {
    throw new Error("Não foi possível detectar a constante VERSAO no código baixado");
  }
  if (compararVersoes(versaoDetectada, VERSAO) <= 0) {
    throw new Error(`Versão detectada no código baixado (${versaoDetectada}) não é superior à atual (${VERSAO})`);
  }

  // ── Sidecar updater ───────────────────────────────────────────────────────
  // Salva o novo código em agent-update.js (NÃO sobrescreve agent.js em execução).
  // Spawna um script externo (updater.ps1 / updater.sh) como processo detachado.
  // O sidecar aguarda o agente sair, faz o swap e reinicia o serviço.
  // Desta forma o update funciona independente de NSSM, Tarefa Agendada ou spawn direto.
  // ─────────────────────────────────────────────────────────────────────────
  const caminhoScript = fileURLToPath(import.meta.url);
  const dirScript     = path.dirname(caminhoScript);
  const caminhoNovo   = path.join(dirScript, "agent-update.js");

  fs.writeFileSync(caminhoNovo, novoCodigo, "utf8");
  console.log(`[update] Novo código salvo em agent-update.js. Lançando sidecar...`);

  if (os.platform() === "win32") {
    const nssmPath     = path.join(dirScript, "nssm.exe");
    const nodeExePath  = path.join(dirScript, "node.exe");
    const stdOut       = path.join(dirScript, "agent-output.log");
    const stdErr       = path.join(dirScript, "agent-error.log");
    const updaterPath  = path.join(dirScript, "updater.ps1");

    // Escapa aspas simples para string PS1 (caminhos com apóstrofo são raros)
    const esc = (p) => p.replace(/'/g, "''");

    // Monta o script linha a linha (evita backtick JS/PS conflitando no template literal)
    const psLines = [
      "# Nexus RMM — Sidecar Updater (gerado automaticamente)",
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$novo    = '" + esc(caminhoNovo)   + "'",
      "$alvo    = '" + esc(caminhoScript) + "'",
      "$nssm    = '" + esc(nssmPath)      + "'",
      "$nodeExe = '" + esc(nodeExePath)   + "'",
      "$stdOut  = '" + esc(stdOut)        + "'",
      "$stdErr  = '" + esc(stdErr)        + "'",
      "$me      = '" + esc(updaterPath)   + "'",
      "",
      "Start-Sleep -Seconds 4",
      "",
      "if (Test-Path $nssm) {",
      "  & $nssm stop NexusAgente 2>$null | Out-Null",
      "  Start-Sleep -Seconds 2",
      "  Copy-Item $novo $alvo -Force",
      "  & $nssm start NexusAgente 2>$null | Out-Null",
      "} elseif (Get-ScheduledTask -TaskName 'NexusAgente' -ErrorAction SilentlyContinue) {",
      "  Stop-ScheduledTask  -TaskName 'NexusAgente' -ErrorAction SilentlyContinue",
      "  Start-Sleep -Seconds 1",
      "  Copy-Item $novo $alvo -Force",
      "  Start-ScheduledTask -TaskName 'NexusAgente' -ErrorAction SilentlyContinue",
      "} else {",
      "  Copy-Item $novo $alvo -Force",
      "  if (Test-Path $nodeExe) {",
      "    $argStr = '\"' + $alvo + '\"'",
      "    Start-Process -FilePath $nodeExe -ArgumentList $argStr -WorkingDirectory (Split-Path $alvo) -RedirectStandardOutput $stdOut -RedirectStandardError $stdErr -WindowStyle Hidden",
      "  }",
      "}",
      "",
      "Remove-Item $novo -Force -ErrorAction SilentlyContinue",
      "Remove-Item $me  -Force -ErrorAction SilentlyContinue",
    ];
    fs.writeFileSync(updaterPath, psLines.join("\r\n"), "utf8");

    // Resolve powershell.exe sem aspas (spawn não precisa de aspas no executável)
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const psExe = (() => {
      const p = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      return fs.existsSync(p) ? p : "powershell.exe";
    })();

    spawn(psExe, ["-NonInteractive", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", updaterPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();

  } else if (os.platform() === "darwin") {
    // ── macOS: launchctl sidecar ──
    const updaterPath = path.join(dirScript, "updater.sh");
    const plistId = "br.com.nexus-rmm.agente";
    const plistPath = `/Library/LaunchDaemons/${plistId}.plist`;
    const shScript = [
      "#!/bin/sh",
      "sleep 4",
      `cp '${caminhoNovo.replace(/'/g, "'\\''")}' '${caminhoScript.replace(/'/g, "'\\''")}'`,
      `rm -f '${caminhoNovo.replace(/'/g, "'\\''")}'`,
      `rm -f '${updaterPath.replace(/'/g, "'\\''")}'`,
      `launchctl unload '${plistPath}' 2>/dev/null || true`,
      `sleep 1`,
      `launchctl load -w '${plistPath}' 2>/dev/null || true`,
    ].join("\n");
    fs.writeFileSync(updaterPath, shScript, { mode: 0o755 });
    spawn("/bin/sh", [updaterPath], { detached: true, stdio: "ignore" }).unref();

  } else {
    // ── Linux: shell sidecar ──
    const updaterPath = path.join(dirScript, "updater.sh");
    const shScript = [
      "#!/bin/sh",
      "sleep 4",
      `cp '${caminhoNovo.replace(/'/g, "'\\''")}' '${caminhoScript.replace(/'/g, "'\\''")}'`,
      `rm -f '${caminhoNovo.replace(/'/g, "'\\''")}'`,
      `rm -f '${updaterPath.replace(/'/g, "'\\''")}'`,
      "systemctl restart nexus-agente 2>/dev/null || true",
    ].join("\n");
    fs.writeFileSync(updaterPath, shScript, { mode: 0o755 });
    spawn("/bin/sh", [updaterPath], { detached: true, stdio: "ignore" }).unref();
  }

  // NÃO fazemos process.exit() aqui.
  // O sidecar vai chamar `nssm stop` / `Stop-ScheduledTask` / etc., que mata
  // este processo quando estiver pronto — eliminando a corrida onde o NSSM
  // relançava o agente antigo antes do sidecar ter chance de copiar o arquivo.
  //
  // Fallback de segurança: se o sidecar não encerrar o processo em 3 minutos
  // (falha de permissão, política, etc.), resetamos o flag para que o servidor
  // possa tentar enviar o sinal novamente na próxima sessão.
  console.log(`[update] Sidecar lançado. Aguardando encerramento pelo sidecar (máx. 3 min)...`);
  setTimeout(() => {
    _atualizandoAgente = false;
    console.warn("[update] Sidecar não encerrou o processo em 3 minutos — resetando flag para nova tentativa.");
  }, 3 * 60 * 1000).unref?.();
}


// --- Tela (acesso não supervisionado — DXGI nativo, sem TightVNC) ----------
let telaWs = null;     // WebSocket com o relay
let telaHelper = null; // WebSocket local com nexus-screen.exe

const HELPER_PORT = 7701;
const HELPER_URL  = `ws://127.0.0.1:${HELPER_PORT}/ws`;

function caminhoHelper() {
  if (os.platform() === "linux") {
    // Em Linux, instala junto com o agente em /opt/nexus-rmm/
    const arch = os.arch() === "arm64" ? "arm64" : "amd64";
    const dir = path.dirname(fileURLToPath(import.meta.url));
    return path.join(dir, `nexus-screen-linux-${arch}`);
  }
  // ProgramData (C:\ProgramData) é acessível tanto pelo SYSTEM (Session 0, NSSM/download)
  // quanto pelo usuário interativo (Session 1, Task Scheduler que lança o exe).
  // LOCALAPPDATA/APPDATA do SYSTEM aponta para C:\Windows\system32\config\systemprofile\...
  // que é inacessível a usuários normais — causava tela preta porque o Task Scheduler
  // não conseguia encontrar o nexus-screen.exe baixado pelo agente SYSTEM.
  const programData = process.env.ProgramData || process.env.PROGRAMDATA || "C:\\ProgramData";
  return path.join(programData, "NexusAgente", "nexus-screen.exe");
}

async function garantirNexusScreenLinux() {
  const exePath = caminhoHelper();
  const arch = os.arch() === "arm64" ? "arm64" : "amd64";
  const urlBin = `${API_URL}/nexus-screen-linux-${arch}`;

  // Baixar se não existir
  if (!fs.existsSync(exePath)) {
    console.log(`• [TELA-LINUX] Baixando nexus-screen-linux-${arch}...`);
    try {
      const res = await fetch(urlBin);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      fs.writeFileSync(exePath, Buffer.from(buf), { mode: 0o755 });
      console.log("✓ [TELA-LINUX] binário pronto em", exePath);
    } catch (err) {
      console.error("✗ [TELA-LINUX] Falha ao baixar:", err.message);
      return false;
    }
  }

  // Checar se já está rodando
  try {
    const check = await fetch(`http://127.0.0.1:${HELPER_PORT}/health`, { signal: AbortSignal.timeout(800) });
    if (check.ok) {
      console.log("✓ [TELA-LINUX] helper já ativo — reutilizando");
      return true;
    }
  } catch { /* não estava rodando */ }

  // Detectar DISPLAY (necessário para X11)
  const display = process.env.DISPLAY || ":0";
  const xauthority = process.env.XAUTHORITY ||
    (process.env.HOME ? `${process.env.HOME}/.Xauthority` : "/root/.Xauthority");

  console.log(`• [TELA-LINUX] Iniciando helper (DISPLAY=${display})...`);
  const helperProc = spawn(exePath, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, DISPLAY: display, XAUTHORITY: xauthority },
  });
  helperProc.unref();

  // Aguardar até 8s
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${HELPER_PORT}/health`, { signal: AbortSignal.timeout(300) });
      if (res.ok) { console.log("✓ [TELA-LINUX] helper respondendo"); return true; }
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  console.error("✗ [TELA-LINUX] helper não respondeu em 8s. DISPLAY configurado? xdotool instalado?");
  return false;
}

async function garantirNexusScreenMacOS() {
  // Usa nexus-screen-macos.js (Node.js) — sem necessidade de binário compilado
  const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "nexus-screen-macos.js");
  const scriptUrl  = `${API_URL}/nexus-screen-macos.js`;

  // Baixar se não existir
  if (!fs.existsSync(scriptPath)) {
    console.log("• [TELA-MACOS] Baixando nexus-screen-macos.js...");
    try {
      const res = await fetch(scriptUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const txt = await res.text();
      fs.writeFileSync(scriptPath, txt, { mode: 0o644 });
      console.log("✓ [TELA-MACOS] script pronto em", scriptPath);
    } catch (err) {
      console.error("✗ [TELA-MACOS] Falha ao baixar:", err.message);
      return false;
    }
  }

  // Checar se já está rodando
  try {
    const check = await fetch(`http://127.0.0.1:${HELPER_PORT}/health`, { signal: AbortSignal.timeout(800) });
    if (check.ok) { console.log("✓ [TELA-MACOS] helper já ativo — reutilizando"); return true; }
  } catch { /* não rodando */ }

  // Iniciar com o mesmo Node.js que roda o agente
  const nodeBin = process.execPath;
  console.log(`• [TELA-MACOS] Iniciando helper (${nodeBin} ${scriptPath})...`);
  const helperProc = spawn(nodeBin, [scriptPath], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, NEXUS_SCREEN_PORT: String(HELPER_PORT) },
  });
  helperProc.unref();

  // Aguardar até 10s
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${HELPER_PORT}/health`, { signal: AbortSignal.timeout(300) });
      if (res.ok) { console.log("✓ [TELA-MACOS] helper respondendo"); return true; }
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  console.error("✗ [TELA-MACOS] helper não respondeu em 10s");
  return false;
}

async function garantirNexusScreen() {
  if (os.platform() === "linux")  return garantirNexusScreenLinux();
  if (os.platform() === "darwin") return garantirNexusScreenMacOS();
  if (os.platform() !== "win32") return false;

  const exePath = caminhoHelper();
  const baseDir = path.dirname(exePath);
  fs.mkdirSync(baseDir, { recursive: true });

  // Baixar se não existir (o servidor web serve /nexus-screen.exe)
  if (!fs.existsSync(exePath)) {
    console.log("• [DXGI] Baixando nexus-screen.exe...");
    try {
      const res = await fetch(`${API_URL}/nexus-screen.exe`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      fs.writeFileSync(exePath, Buffer.from(buf));
      console.log("✓ [DXGI] nexus-screen.exe pronto em", exePath);
    } catch (err) {
      console.error("✗ [DXGI] Falha ao baixar nexus-screen.exe:", err.message);
      return false;
    }
  }

  // IMPORTANTE: nexus-screen.exe PRECISA rodar na sessão interativa do usuário (Session 1)
  // para ter acesso à API DXGI Desktop Duplication. O agente corre como serviço Windows
  // (Session 0 / SYSTEM) — se matarmos e reiniciarmos daqui, o novo processo fica em
  // Session 0 onde não existe desktop → DXGI falha → tela preta permanente.
  // Estratégia: se já está rodando e respondendo (sessão correta), REUTILIZAR o processo.
  // Só mata e reinicia se o processo morreu (health check falha).
  try {
    const check = await fetch(`http://127.0.0.1:${HELPER_PORT}/health`, { signal: AbortSignal.timeout(1000) });
    if (check.ok) {
      console.log("✓ [DXGI] nexus-screen.exe já ativo (sessão correta) — reutilizando processo");
      return true;
    }
  } catch { /* não estava rodando */ }

  // Processo morto ou não respondeu: limpar instância travada e reiniciar.
  try {
    await execAsync(`taskkill /F /IM nexus-screen.exe`, { timeout: 5000 });
    await new Promise(r => setTimeout(r, 600));
  } catch { /* não havia instância */ }

  // Lançar via Task Scheduler com principal interativo (Session 1).
  // Start-Process herdaria a Session 0 do serviço NSSM/SYSTEM → DXGI sem desktop → tela preta.
  // Task Scheduler com LogonType Interactive associa o processo ao desktop do usuário logado.
  const exeEsc = exePath.replace(/'/g, "''");
  const launchLines = [
    "$ErrorActionPreference = 'Stop'",
    "$taskName = 'NexusScreenLauncher'",
    `$exe = '${exeEsc}'`,
    "$loginUser = (Get-WmiObject Win32_ComputerSystem).UserName",
    "if (-not $loginUser) { Write-Output 'no-user'; exit 0 }",
    "Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue",
    "$action = New-ScheduledTaskAction -Execute $exe",
    "$principal = New-ScheduledTaskPrincipal -UserId $loginUser -LogonType Interactive -RunLevel Highest",
    "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -MultipleInstances IgnoreNew",
    "Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null",
    "Start-ScheduledTask -TaskName $taskName",
    "Write-Output 'launched'",
  ];
  // Escreve PS1 temporário para evitar problemas de escaping no -Command
  const tempPs1 = path.join(path.dirname(exePath), "launch-screen.ps1");
  fs.writeFileSync(tempPs1, launchLines.join("\r\n"), "utf8");

  try {
    const { stdout } = await execAsync(
      `${obterPowershellCmd()} -NoProfile -ExecutionPolicy Bypass -File "${tempPs1}"`,
      { timeout: 15000, windowsHide: true }
    );
    const saida = (stdout || "").trim();
    if (saida === "no-user") {
      console.error("✗ [DXGI] Nenhum usuário interativo logado — helper precisa de Session 1");
      return false;
    }
    console.log("• [DXGI]", saida || "helper lançado via Task Scheduler");
  } catch (err) {
    console.error("✗ [DXGI] Falha ao lançar helper via Task Scheduler:", err.message);
    return false;
  } finally {
    try { fs.unlinkSync(tempPs1); } catch {}
  }

  // Aguardar o helper ficar disponível (até 10s)
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${HELPER_PORT}/health`, { signal: AbortSignal.timeout(300) });
      if (res.ok) { console.log("✓ [DXGI] helper respondendo"); return true; }
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  console.error("✗ [DXGI] helper não respondeu em 10s");
  return false;
}

// Obtém lista de monitores do helper
async function obterMonitores() {
  if (os.platform() !== "win32" && os.platform() !== "linux" && os.platform() !== "darwin") return [];
  try {
    const res = await fetch(`http://127.0.0.1:${HELPER_PORT}/monitores`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const lista = await res.json();
    // normaliza para o formato que o viewer espera
    return lista.map((m, i) => ({ x: m.x || 0, y: m.y || 0, w: m.w || 0, h: m.h || 0, principal: i === 0 }));
  } catch {
    return [];
  }
}

// Abre o túnel de vídeo: nexus-screen.exe (WS local) <-> relay (WS remoto)
async function iniciarTela(cfg, state) {
  console.log("🖥️ pedido de tela recebido do servidor");

  const ok = await garantirNexusScreen();
  if (!ok) {
    console.error("✗ [DXGI] helper não disponível — abortando tela");
    return;
  }

  // Relay já conectado: reutilizar se o helper também estiver vivo.
  // ATENÇÃO: se garantirNexusScreen() reiniciou o nexus-screen.exe, o telaHelper (WS
  // para o processo antigo) está morto. Precisamos reconectar o helper ao processo novo —
  // caso contrário o relay não recebe frames e a tela fica preta.
  if (telaWs && telaWs.readyState === WebSocket.OPEN) {
    if (telaHelper && telaHelper.readyState === WebSocket.OPEN) {
      console.log("ℹ️ [DXGI] Relay e helper WS já conectados — reutilizando.");
      return;
    }
    // Helper morto (nexus-screen.exe foi reiniciado): reconectar só o helper.
    console.log("ℹ️ [DXGI] Relay ativo, helper morto — reconectando helper ao nexus-screen recém-iniciado");
    if (telaHelper) { try { telaHelper.close(); } catch {} telaHelper = null; }
    const relayRef = telaWs; // captura referência local
    const helperRecon = new WebSocket(HELPER_URL);
    telaHelper = helperRecon;
    helperRecon.binaryType = "nodebuffer";
    helperRecon.on("open", () => {
      console.log("✓ [DXGI] helper WS reconectado — iniciando streaming imediatamente");
      // O relay já enviou {type:"open"} quando o viewer conectou e NÃO envia de novo.
      // Precisamos kickar o nexus-screen.exe diretamente para ele começar a capturar frames.
      try { helperRecon.send(JSON.stringify({ cmd: "qualidade", q: 65 })); } catch {}
    });
    helperRecon.on("message", (data, isBinary) => {
      if (isBinary && relayRef.readyState === WebSocket.OPEN) {
        relayRef.send(data, { binary: true });
      }
    });
    helperRecon.on("close", () => { console.log("🔴 [DXGI] helper WS fechado"); if (telaHelper === helperRecon) telaHelper = null; });
    helperRecon.on("error", (e) => console.error("[DXGI] helper erro (recon):", e.message));
    return;
  }
  if (telaWs) { try { telaWs.close(); } catch {} telaWs = null; }
  if (telaHelper) { try { telaHelper.close(); } catch {} telaHelper = null; }

  const relayUrl =
    `${cfg.relayUrl}?token=${encodeURIComponent(cfg.agentToken)}` +
    `&machineId=${encodeURIComponent(cfg.machineId || state.machineId)}` +
    `&hostname=${encodeURIComponent(os.hostname())}`;

  let tentarReconectar = true;
  let retryCount = 0;
  const maxRetries = 15;

  function conectar() {
    if (!tentarReconectar) return;

    const relay = new WebSocket(relayUrl);
    telaWs = relay;
    relay.binaryType = "nodebuffer";

    relay.on("open", () => {
      console.log("✓ [DXGI] relay WS conectado");
      retryCount = 0;

      // Conectar ao helper local
      const helper = new WebSocket(HELPER_URL);
      telaHelper = helper;
      helper.binaryType = "nodebuffer";

      helper.on("open", () => {
        console.log("✓ [DXGI] helper WS conectado — kickando streaming");
        // Safety net: se o relay já recebeu {type:"open"} ANTES do helper conectar,
        // o nexus-screen.exe nunca recebe o start command. Mandamos aqui sempre.
        try { helper.send(JSON.stringify({ cmd: "qualidade", q: 65 })); } catch {}
      });

      // frames do helper → relay (binário)
      helper.on("message", (data, isBinary) => {
        if (isBinary && relay.readyState === WebSocket.OPEN) {
          relay.send(data, { binary: true });
        }
      });

      helper.on("close", () => {
        console.log("🔴 [DXGI] helper WS fechado");
        telaHelper = null;
      });
      helper.on("error", (e) => console.error("[DXGI] helper erro:", e.message));
    });

    // mensagens do relay → helper (comandos do viewer: JSON ou binário)
    relay.on("message", (data, isBinary) => {
      if (!telaHelper || telaHelper.readyState !== WebSocket.OPEN) return;
      // O relay nos manda o objeto {type:"open"} quando o viewer conecta
      if (!isBinary) {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.type === "open") {
          console.log("▶️ [DXGI] viewer conectado — streaming iniciado");
          // Envia qualidade inicial
          telaHelper.send(JSON.stringify({ cmd: "qualidade", q: 65 }));
        } else if (msg.type === "close") {
          console.log("⏹️ [DXGI] viewer desconectado");
        } else {
          // comando passthrough (qualidade, monitor, fps, mouse, key...)
          telaHelper.send(JSON.stringify(msg), { binary: false });
        }
      } else {
        telaHelper.send(data, { binary: true });
      }
    });

    relay.on("close", (code, reason) => {
      if (telaHelper) { try { telaHelper.close(); } catch {} telaHelper = null; }
      if (telaWs === relay) {
        telaWs = null;
        const r = reason ? reason.toString() : "";
        if ([1008, 4001, 1015, 1002].includes(code) ||
            r.includes("Unauthorized") || r.includes("agente offline")) {
          console.log(`🔴 [DXGI] relay encerrado permanentemente (${code})`);
          tentarReconectar = false;
          return;
        }
        if (tentarReconectar && retryCount < maxRetries) {
          retryCount++;
          console.log(`⚠️ [DXGI] relay fechado (${code}). Reconectando (${retryCount}/${maxRetries}) em 3s...`);
          setTimeout(conectar, 3000);
        } else {
          console.log("❌ [DXGI] limite de reconexões atingido.");
          tentarReconectar = false;
        }
      }
    });

    relay.on("error", (e) => console.error("[DXGI] relay erro:", e.message));
  }

  conectar();
}

// ---------------------------------------------------------------------------
//  medirCpuRam — coleta CPU% (delta entre amostras) e RAM% em uso.
//  Primeira chamada inicializa o baseline; chamadas subsequentes retornam delta.
// ---------------------------------------------------------------------------
let _cpuBaseline = null;
function medirCpuRam() {
  const cpus = os.cpus();
  const agora = cpus.map((c) => ({ ...c.times }));

  let cpuPercent = 0;
  if (_cpuBaseline && _cpuBaseline.length === agora.length) {
    let totalTick = 0, totalIdle = 0;
    for (let i = 0; i < agora.length; i++) {
      for (const t of Object.keys(agora[i])) {
        const diff = (agora[i][t] || 0) - (_cpuBaseline[i][t] || 0);
        totalTick += diff;
        if (t === "idle") totalIdle += diff;
      }
    }
    cpuPercent = totalTick > 0 ? Math.round((1 - totalIdle / totalTick) * 100) : 0;
  }
  _cpuBaseline = agora;

  const ramPercent = Math.round((os.totalmem() - os.freemem()) / os.totalmem() * 100);
  return { cpu: cpuPercent, ram: ramPercent };
}

async function main() {
  // Salvar o PID do processo para que instaladores e atualizadores possam identificá-lo
  try {
    fs.writeFileSync(path.join(__dirname, "agent.pid"), process.pid.toString(), "utf8");
  } catch (err) {
    console.warn("Aviso: não foi possível salvar o arquivo agent.pid:", err.message);
  }

  // Ao iniciar (ex: após auto-update), encerrar qualquer instância antiga do nexus-screen.exe.
  // Isso garante que a próxima requisição de tela relançará o helper na Session correta
  // (via Task Scheduler Session 1). Sem isso, a instância antiga (Session 0 → tela preta)
  // responde ao health-check e é reutilizada mesmo após o agente ser atualizado.
  if (os.platform() === "win32") {
    try {
      await execAsync("taskkill /F /IM nexus-screen.exe 2>nul", { timeout: 5000 });
      console.log("• [startup] nexus-screen.exe antigo encerrado — será relançado na Session 1 quando necessário");
    } catch {
      // Não havia instância rodando — normal no primeiro boot
    }
  }

  const state = await obterEstado();
  state.watchdogs = carregarWatchdogs();
  console.log("→ conectando ao gateway mTLS:", GATEWAY_URL);

  const socket = io(`${GATEWAY_URL}/agent`, {
    transports: ["websocket"],
    ca: state.ca,
    cert: state.cert,
    key: state.key,
    rejectUnauthorized: true,
    reconnection: true,
    reconnectionDelayMax: 30_000,
  });

  const inicio = Date.now();
  
  socket.on("connect", () => {
    console.log("🟢 ONLINE — conectado ao gateway");

    // Pré-aquece o nexus-screen.exe para que esteja pronto quando o servidor
    // pedir a lista de monitores (server:get-monitors). Fire-and-forget.
    if (os.platform() === "win32") {
      garantirNexusScreen().catch(() => {});
    }

    // Coleta e envia o inventário de serviços ao conectar
    obterServicosWindows().then((servicos) => {
      socket.emit("agent:service-inventory", {
        machineId: state.machineId,
        services: servicos.map(s => ({
          Name: s.Name,
          DisplayName: s.DisplayName,
          Status: s.Status,
          StartType: s.StartType
        })),
        enviadoEm: Date.now()
      });
      console.log(`✓ Inventário inicial de serviços enviado: ${servicos.length} serviços.`);
    }).catch(err => {
      console.error("Erro ao obter serviços na conexão:", err.message);
    });

    // Coleta e envia o inventário completo do sistema (hardware, SO, rede, software)
    obterInventarioSistema().then((inv) => {
      inv.machineId = state.machineId;
      socket.emit("agent:inventory", inv);
      console.log(`✓ Inventário do sistema enviado: ${inv.hardware.cpu.modelo}, ${inv.software.length} softwares.`);
    }).catch(err => {
      console.error("Erro ao obter inventário do sistema na conexão:", err.message);
    });
  });

  // Map para gerenciar sessões de terminal ativas do agente
  // Cada entrada: { proc: ChildProcess|IPty, isPty: boolean }
  const activeShells = new Map();

  // Buffer de linha para o editor local em modo pipe (spawn sem PTY).
  // Permite backspace/delete sem PTY — o agente faz o line editing antes de enviar para stdin.
  const lineEditorBuffers = new Map(); // sessionId → string

  function matarTerminal(entry) {
    if (!entry) return;
    try {
      if (entry.isWorker) {
        // Worker thread: pede ao PTY para fechar, então termina o worker
        try { entry.proc.postMessage({ type: "kill" }); } catch {}
        setTimeout(() => { try { entry.proc.terminate(); } catch {} }, 500);
      } else if (entry.isPty) {
        entry.proc.kill();
      } else {
        entry.proc.kill("SIGKILL");
      }
    } catch {}
  }

  socket.on("disconnect", (r) => {
    console.log("🔴 desconectado:", r);
    // Mata qualquer terminal ativo na desconexão
    for (const entry of activeShells.values()) {
      matarTerminal(entry);
    }
    activeShells.clear();
    lineEditorBuffers.clear();
  });

  socket.on("connect_error", (e) => console.error("erro de conexão:", e.message));

  // Spawn pipe mode (fallback sem PTY): usado quando node-pty não está disponível
  // ou quando o worker PTY não conseguiu inicializar (ex: Session 0 sem acesso ao desktop).
  function iniciarSpawnPipeMode(sessionId, cmdExe, args) {
    try {
      const child = spawn(cmdExe, args, { env: process.env, windowsHide: true });
      activeShells.set(sessionId, { proc: child, isPty: false, isWorker: false });

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk) => {
        socket.emit("agent:terminal-stdout", { sessionId, data: chunk });
      });
      child.stderr.on("data", (chunk) => {
        socket.emit("agent:terminal-stdout", { sessionId, data: chunk });
      });
      child.on("close", (code) => {
        console.log(`💻 Sessão pipe encerrada (session: ${sessionId}, code: ${code})`);
        socket.emit("agent:terminal-exit", { sessionId, code });
        activeShells.delete(sessionId);
        lineEditorBuffers.delete(sessionId);
      });
      child.on("error", (err) => {
        console.error(`💻 Erro pipe (session: ${sessionId}):`, err.message);
        socket.emit("agent:terminal-stdout", { sessionId, data: `\r\nErro ao iniciar shell: ${err.message}\r\n` });
        socket.emit("agent:terminal-exit", { sessionId, code: -1 });
        activeShells.delete(sessionId);
        lineEditorBuffers.delete(sessionId);
      });

      if (os.platform() === "win32") {
        // Em pipe mode (Session 0 / SYSTEM), PowerShell não imprime prompt automático.
        // Enviamos uma linha inicial para o usuário saber que o terminal está ativo.
        child.stdin.write(
          "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; " +
          "Write-Host '[Nexus RMM] Terminal pronto (modo pipe/Session 0)' -ForegroundColor Green; " +
          "Write-Host \"PS $(Get-Location)> \" -NoNewline -ForegroundColor Cyan\r\n"
        );
      }
    } catch (err) {
      console.error("Erro crítico ao spawnar terminal:", err.message);
      socket.emit("agent:terminal-stdout", { sessionId, data: `\r\nErro crítico: ${err.message}\r\n` });
      socket.emit("agent:terminal-exit", { sessionId, code: -1 });
    }
  }

  // --- Terminal Interativo com PTY real via worker_threads ---
  // O PTY roda em worker_threads para não bloquear o event loop do agente.
  // Em Session 0 (serviço Windows), ConPTY pode bloquear por ~30s — no worker isso é seguro.
  // Se PTY não responder em 10s, cai automaticamente para spawn pipe mode.
  socket.on("server:terminal-start", (cfg) => {
    const { sessionId } = cfg;
    if (activeShells.has(sessionId)) return;

    // Sempre força PowerShell no Windows (CMD removido)
    const psPath = obterPowershellCmd().replace(/"/g, "");
    const cmdExe = os.platform() === "win32" ? psPath : "/bin/bash";
    const args = os.platform() === "win32" ? ["-NoProfile", "-ExecutionPolicy", "Bypass"] : ["-i"];

    const inSession0 = isSession0Windows();
    console.log(`💻 Iniciando terminal PTY_PATH=${ptyModulePath ? "ok" : "null"} session0=${inSession0} shell=${cmdExe} (session: ${sessionId})`);

    // --- Caminho 1: PTY via worker thread ---
    // Session 0 (serviço SYSTEM): ConPTY e winpty não têm acesso ao desktop interativo.
    // Pula diretamente para spawn pipe mode que funciona com stdin/stdout simples.
    if (ptyModulePath && !inSession0) {
      let ptyReady = false;

      const worker = new Worker(PTY_WORKER_CODE, {
        eval: true,
        workerData: {
          ptyModulePath,
          cmd: cmdExe,
          args,
          opts: {
            name: "xterm-256color",
            cols: 80,
            rows: 24,
            cwd: process.env.USERPROFILE || process.env.HOME || process.cwd(),
            env: { ...process.env },
            useConpty: false, // winpty.dll funciona em Session 0; ConPTY requer console interativo (falha em serviço)
          },
        },
      });

      activeShells.set(sessionId, { proc: worker, isPty: true, isWorker: true });

      // Timeout de segurança: se PTY não responder em 10s → fallback para pipe mode
      const workerReadyTimeout = setTimeout(() => {
        if (!ptyReady) {
          console.error(`⚠️ Worker PTY não respondeu em 10s (session: ${sessionId}) — caindo para pipe mode`);
          worker.terminate();
          activeShells.delete(sessionId);
          iniciarSpawnPipeMode(sessionId, cmdExe, args);
        }
      }, 10000);

      worker.on("message", (msg) => {
        if (msg.type === "ready") {
          ptyReady = true;
          clearTimeout(workerReadyTimeout);
          console.log(`✓ [PTY] Worker pronto (session: ${sessionId})`);
          if (os.platform() === "win32") {
            setTimeout(() => {
              try {
                worker.postMessage({ type: "write", data: "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; Clear-Host\r" });
              } catch {}
            }, 300);
          }
        } else if (msg.type === "data") {
          socket.emit("agent:terminal-stdout", { sessionId, data: msg.data });
        } else if (msg.type === "exit") {
          clearTimeout(workerReadyTimeout);
          if (ptyReady) {
            // PTY estava funcionando — encerramento legítimo pelo usuário ou pelo shell
            console.log(`💻 Worker PTY encerrado (session: ${sessionId}, code: ${msg.code})`);
            socket.emit("agent:terminal-exit", { sessionId, code: msg.code });
            activeShells.delete(sessionId);
            lineEditorBuffers.delete(sessionId);
          } else {
            // ConPTY falhou antes de emitir 'ready' (típico em Session 0 / serviço SYSTEM).
            // NÃO enviar agent:terminal-exit — o painel fecharia o terminal antes do fallback.
            // Cai silenciosamente para spawn pipe mode, que funciona em Session 0.
            console.error(`⚠️ Worker PTY saiu antes do ready (code: ${msg.code}, session: ${sessionId}) — caindo para pipe mode`);
            try { worker.terminate(); } catch {}
            activeShells.delete(sessionId);
            iniciarSpawnPipeMode(sessionId, cmdExe, args);
          }
        } else if (msg.type === "error") {
          clearTimeout(workerReadyTimeout);
          console.error(`⚠️ Worker PTY erro: ${msg.message} — caindo para pipe mode`);
          worker.terminate();
          activeShells.delete(sessionId);
          iniciarSpawnPipeMode(sessionId, cmdExe, args);
        }
      });

      worker.on("error", (err) => {
        clearTimeout(workerReadyTimeout);
        if (!ptyReady) {
          console.error(`⚠️ Worker erro antes do ready: ${err.message} — caindo para pipe mode`);
          activeShells.delete(sessionId);
          iniciarSpawnPipeMode(sessionId, cmdExe, args);
        }
      });

      worker.on("exit", () => {
        clearTimeout(workerReadyTimeout);
      });

      return;
    }

    // --- Caminho 2: spawn pipe mode (sem PTY) ---
    iniciarSpawnPipeMode(sessionId, cmdExe, args);
  });

  socket.on("server:terminal-input", (payload) => {
    const { sessionId, data } = payload;
    const entry = activeShells.get(sessionId);
    if (!entry) return;

    // PTY mode: repassa direto (PTY cuida do line editing e echo)
    if (entry.isPty) {
      if (entry.isWorker) {
        try { entry.proc.postMessage({ type: "write", data }); } catch {}
      } else {
        try { entry.proc.write(data); } catch {}
      }
      return;
    }

    // Pipe mode: line editor local — PowerShell não processa backspace em modo pipe.
    // O agente bufferiza a linha, trata backspace com visual feedback, e envia
    // a linha completa para stdin apenas no Enter.
    if (!lineEditorBuffers.has(sessionId)) lineEditorBuffers.set(sessionId, "");
    let buf = lineEditorBuffers.get(sessionId);

    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      const code = data.charCodeAt(i);

      if (code === 127 || code === 8) {
        // Backspace / Delete — apaga último char do buffer e ecoa feedback visual
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
          socket.emit("agent:terminal-stdout", { sessionId, data: "\x08 \x08" });
        }
      } else if (ch === "\r" || ch === "\n") {
        // Enter — envia linha completa para stdin do PowerShell
        try {
          if (entry.proc.stdin && entry.proc.stdin.writable) {
            entry.proc.stdin.write(buf + "\r\n");
          }
        } catch {}
        socket.emit("agent:terminal-stdout", { sessionId, data: "\r\n" });
        buf = "";
      } else if (code === 3) {
        // Ctrl+C — matar processos FILHOS do PowerShell, NÃO o PowerShell em si.
        // O proc.kill() encerraria a sessão — errado.
        // Bug anterior: o | no comando era interpretado como pipe pelo cmd.exe (exec usa cmd.exe).
        // Solução: -EncodedCommand (base64) — bypassa completamente o cmd.exe e evita escapes.
        socket.emit("agent:terminal-stdout", { sessionId, data: "^C\r\n" });
        buf = "";
        if (entry.proc.pid && os.platform() === "win32") {
          const ppid = entry.proc.pid;
          const psCmd =
            `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${ppid}' |` +
            ` Where-Object { $_.Name -notmatch '^conhost\\.exe$' } |` +
            ` ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
          const encoded = Buffer.from(psCmd, "utf16le").toString("base64");
          execAsync(
            `${obterPowershellCmd()} -NonInteractive -NoProfile -EncodedCommand ${encoded}`,
            { timeout: 8000 }
          ).catch(() => {});
        }
      } else if (code >= 32 || code === 9) {
        // Caractere imprimível ou Tab — ecoa e adiciona ao buffer
        buf += ch;
        socket.emit("agent:terminal-stdout", { sessionId, data: ch });
      }
      // Outros caracteres de controle (setas, F-keys, Esc) são ignorados em pipe mode
    }

    lineEditorBuffers.set(sessionId, buf);
  });

  // Redimensionar PTY quando o painel muda de tamanho
  socket.on("server:terminal-resize", (payload) => {
    const { sessionId, cols, rows } = payload || {};
    const entry = activeShells.get(sessionId);
    if (entry && entry.isPty && cols && rows) {
      if (entry.isWorker) {
        try { entry.proc.postMessage({ type: "resize", cols, rows }); } catch {}
      } else {
        try { entry.proc.resize(cols, rows); } catch {}
      }
    }
  });

  socket.on("server:terminal-stop", (payload) => {
    const { sessionId } = payload;
    const entry = activeShells.get(sessionId);
    if (entry) {
      matarTerminal(entry);
      activeShells.delete(sessionId);
    }
    lineEditorBuffers.delete(sessionId);
  });

  // 🖥️ Acesso à tela: o servidor pede (via mTLS) para abrir o túnel de vídeo.
  socket.on("server:screen-start", async (cfg) => {
    try {
      await iniciarTela(cfg, state);
    } catch (e) {
      console.error("Erro ao iniciar tela:", e.message);
    }
  });

  // Lista de monitores (para o viewer permitir focar uma tela específica).
  socket.on("server:get-monitors", async () => {
    const monitores = await obterMonitores();
    socket.emit("agent:monitors", { machineId: state.machineId, monitores });
  });

  // ── Multi-monitor: listar monitores disponíveis ─────────────────────────────
  socket.on("server:list-monitors", async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${HELPER_PORT}/monitores`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const monitores = await res.json();
      socket.emit("agent:monitors-list", { monitores });
    } catch (err) {
      console.warn("[tela] listar monitores:", err.message);
      // fallback: reporta 1 monitor genérico para não bloquear o painel
      socket.emit("agent:monitors-list", { monitores: [{ idx: 0, w: 0, h: 0, x: 0, y: 0 }] });
    }
  });

  // ── Multi-monitor: trocar monitor ativo na sessão de tela ────────────────────
  socket.on("server:screen-select-monitor", (payload) => {
    const idx = Number((payload || {}).monitorIdx) || 0;
    if (telaHelper && telaHelper.readyState === WebSocket.OPEN) {
      try {
        telaHelper.send(JSON.stringify({ cmd: "monitor", idx }));
        console.log(`[tela] monitor trocado -> idx=${idx}`);
      } catch (err) {
        console.warn("[tela] trocar monitor:", err.message);
      }
    } else {
      console.warn("[tela] trocar monitor: helper não está conectado");
    }
  });

  // Wake-on-LAN: este agente atua como relay para acordar outra máquina na mesma rede
  socket.on("server:wol", async (payload) => {
    const targetMac = (payload?.targetMac || "").trim();
    if (!targetMac || !/^([0-9a-fA-F]{2}[:\-]){5}[0-9a-fA-F]{2}$/.test(targetMac)) {
      console.warn("[WoL] MAC inválido recebido:", targetMac);
      return;
    }
    try {
      const { createSocket } = await import("node:dgram");
      const macBytes = targetMac.replace(/[:\-]/g, "").match(/.{2}/g).map(b => parseInt(b, 16));
      const pkt = Buffer.alloc(102);
      pkt.fill(0xff, 0, 6);
      for (let i = 0; i < 16; i++) Buffer.from(macBytes).copy(pkt, 6 + i * 6);
      const sock = createSocket("udp4");
      sock.bind(0, () => {
        sock.setBroadcast(true);
        sock.send(pkt, 0, pkt.length, 9, "255.255.255.255", (err) => {
          sock.close();
          if (err) console.error("[WoL] Erro ao enviar magic packet:", err.message);
          else console.log(`✓ [WoL] Magic packet enviado para ${targetMac}`);
        });
      });
    } catch (err) {
      console.error("[WoL] Falha ao criar socket UDP:", err.message);
    }
  });

  // Trata comandos do servidor
  socket.on("server:command", async (cmd) => {
    console.log("📥 Comando recebido:", cmd.type, "ID:", cmd.commandId);
    
    // 1. Validar assinatura
    if (!verificarAssinatura(cmd, state.ca)) {
      console.warn("⚠️ Comando rejeitado: Assinatura inválida!");
      socket.emit("agent:command-result", {
        commandId: cmd.commandId,
        status: "FALHA",
        error: "Assinatura digital inválida",
        finishedAt: Date.now()
      });
      return;
    }

    // 2. Validar expiração (ex. se expiresAt < agora)
    if (Date.now() > cmd.expiresAt) {
      console.warn("⚠️ Comando rejeitado: Expirado!");
      socket.emit("agent:command-result", {
        commandId: cmd.commandId,
        status: "FALHA",
        error: "Comando expirado",
        finishedAt: Date.now()
      });
      return;
    }

    // 3. Executar o comando
    if (cmd.type === "service.action") {
      try {
        await executarAcaoServico(cmd.service, cmd.action, cmd.startupType);
        console.log(`✓ Ação ${cmd.action} executada com sucesso no serviço ${cmd.service}`);
        
        socket.emit("agent:command-result", {
          commandId: cmd.commandId,
          status: "SUCESSO",
          finishedAt: Date.now()
        });

        // Reenvia inventário atualizado após alteração
        const servicos = await obterServicosWindows();
        socket.emit("agent:service-inventory", {
          machineId: state.machineId,
          services: servicos.map(s => ({
            Name: s.Name,
            DisplayName: s.DisplayName,
            Status: s.Status,
            StartType: s.StartType
          })),
          enviadoEm: Date.now()
        });
      } catch (err) {
        console.error(`✗ Falha ao executar ação no serviço:`, err.message);
        socket.emit("agent:command-result", {
          commandId: cmd.commandId,
          status: "FALHA",
          error: err.message,
          finishedAt: Date.now()
        });
      }
    } else if (cmd.type === "service.set-watchdog") {
      try {
        if (cmd.enabled) state.watchdogs.add(cmd.service);
        else state.watchdogs.delete(cmd.service);
        salvarWatchdogs(state.watchdogs);
        console.log(`✓ Watchdog ${cmd.enabled ? "ATIVADO" : "desativado"} para ${cmd.service}`);
        socket.emit("agent:command-result", { commandId: cmd.commandId, status: "SUCESSO", finishedAt: Date.now() });
      } catch (err) {
        socket.emit("agent:command-result", { commandId: cmd.commandId, status: "FALHA", error: err.message, finishedAt: Date.now() });
      }
    } else if (cmd.type === "shell.run") {
      // Terminal de comandos: roda o comando e devolve a saída (stdout+stderr).
      try {
        let saida = "";
        if (os.platform() === "linux") {
          try {
            const { stdout, stderr } = await execAsync(cmd.command, { timeout: 180_000, maxBuffer: 8 * 1024 * 1024, shell: "/bin/bash" });
            saida = (stdout || "") + (stderr ? `\n${stderr}` : "");
          } catch (e) {
            saida = (e.stdout || "") + (e.stderr ? `\n${e.stderr}` : "") + (!e.stdout && !e.stderr ? (e.message || "") : "");
          }
        } else {
          const isCmd = cmd.shell === "cmd";
          const tmp = path.join(os.tmpdir(), `nexus-shell-${cmd.commandId}.${isCmd ? "bat" : "ps1"}`);
          const inp = path.join(os.tmpdir(), `nexus-in-${cmd.commandId}.txt`);
          const prefixo = isCmd
            ? "@chcp 65001 >nul\r\n"
            : "try{$OutputEncoding=[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false}catch{}\r\n";
          fs.writeFileSync(tmp, prefixo + cmd.command, "utf8");
          // Auto-responde prompts S/N (pt) e Y/N (en) — evita travar em chkdsk, del, format, etc.
          fs.writeFileSync(inp, "S\r\nY\r\n".repeat(40), "utf8");
          try {
            const exe = isCmd
              ? `cmd.exe /c "${tmp}" < "${inp}"`
              : `${obterPowershellCmd()} -NoProfile -ExecutionPolicy Bypass -File "${tmp}" < "${inp}"`;
            const { stdout, stderr } = await execAsync(exe, { timeout: 180_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
            saida = (stdout || "") + (stderr ? `\n${stderr}` : "");
          } finally {
            fs.rmSync(tmp, { force: true });
            fs.rmSync(inp, { force: true });
          }
        }
        console.log(`✓ shell.run executado (${(saida || "").length} bytes)`);
        socket.emit("agent:command-result", {
          commandId: cmd.commandId,
          status: "SUCESSO",
          output: saida.slice(0, 1_000_000) || "(sem saída)",
          finishedAt: Date.now(),
        });
      } catch (err) {
        socket.emit("agent:command-result", {
          commandId: cmd.commandId,
          status: "FALHA",
          output: (err.stdout || "") + (err.stderr || ""),
          error: err.message,
          finishedAt: Date.now(),
        });
      }
    } else if (cmd.type === "file.read") {
      // Lê um arquivo e devolve em base64 (limite 10MB).
      try {
        const st = fs.statSync(cmd.path);
        if (st.size > 10 * 1024 * 1024) {
          socket.emit("agent:command-result", { commandId: cmd.commandId, status: "FALHA", error: "Arquivo maior que 10MB.", finishedAt: Date.now() });
        } else {
          const b64 = fs.readFileSync(cmd.path).toString("base64");
          socket.emit("agent:command-result", { commandId: cmd.commandId, status: "SUCESSO", output: b64, finishedAt: Date.now() });
        }
      } catch (err) {
        socket.emit("agent:command-result", { commandId: cmd.commandId, status: "FALHA", error: err.message, finishedAt: Date.now() });
      }
    } else if (cmd.type === "file.write") {
      // Escreve um arquivo (conteúdo em base64).
      try {
        const buf = Buffer.from(cmd.conteudo, "base64");
        if (buf.length > 10 * 1024 * 1024) {
          socket.emit("agent:command-result", { commandId: cmd.commandId, status: "FALHA", error: "Arquivo maior que 10MB.", finishedAt: Date.now() });
        } else {
          fs.mkdirSync(path.dirname(cmd.path), { recursive: true });
          fs.writeFileSync(cmd.path, buf);
          socket.emit("agent:command-result", { commandId: cmd.commandId, status: "SUCESSO", output: `Gravado: ${cmd.path} (${buf.length} bytes)`, finishedAt: Date.now() });
        }
      } catch (err) {
        socket.emit("agent:command-result", { commandId: cmd.commandId, status: "FALHA", error: err.message, finishedAt: Date.now() });
      }
    } else {
      console.warn("⚠️ Comando não suportado:", cmd.type);
      socket.emit("agent:command-result", {
        commandId: cmd.commandId,
        status: "FALHA",
        error: "Tipo de comando não suportado",
        finishedAt: Date.now()
      });
    }
  });

  socket.on("server:update-available", async (updateInfo) => {
    console.log(`[update] Nova versão disponível: ${updateInfo.version}. Iniciando download de ${updateInfo.url}...`);
    try {
      await executarAutoUpdate(updateInfo.url, updateInfo.version);
    } catch (err) {
      _atualizandoAgente = false; // libera o lock para tentar novamente no próximo heartbeat
      console.error("[update] Falha ao atualizar agente:", err.message);
      // Reporta o erro de volta ao servidor para diagnóstico
      try {
        socket.emit("agent:update-error", {
          machineId: state?.machineId,
          versaoAtual: VERSAO,
          versaoAlvo: updateInfo.version,
          erro: err.message,
          stack: (err.stack || "").slice(0, 500),
          timestamp: Date.now(),
        });
      } catch {}
    }
  });

  setInterval(() => {
    if (!socket.connected) return;
    socket.emit("agent:heartbeat", {
      machineId: state.machineId,
      versaoAgente: VERSAO,
      uptimeSegundos: Math.floor((Date.now() - inicio) / 1000),
      enviadoEm: Date.now(),
    });
  }, HEARTBEAT_MS).unref?.();

  // Watchdog: a cada 60s, reinicia serviços vigiados que estiverem parados (self-healing).
  setInterval(async () => {
    if (!socket.connected || !state.watchdogs || state.watchdogs.size === 0) return;
    try {
      const servicos = await obterServicosWindows();
      for (const nome of state.watchdogs) {
        const s = servicos.find((x) => x.Name === nome);
        if (s && String(s.Status).toLowerCase() === "stopped") {
          console.log(`[watchdog] '${nome}' parado — reiniciando...`);
          try {
            await executarAcaoServico(nome, "START");
            socket.emit("agent:watchdog-alert", { machineId: state.machineId, service: nome, acao: "REINICIADO", em: Date.now() });
          } catch (e) {
            socket.emit("agent:watchdog-alert", { machineId: state.machineId, service: nome, acao: "FALHA", erro: e.message, em: Date.now() });
          }
        }
      }
    } catch {}
  }, 60_000).unref?.();

  // Métricas ao vivo (CPU/RAM) a cada 10s — payload minúsculo.
  medirCpuRam(); // inicializa baseline da CPU
  setInterval(() => {
    if (!socket.connected) return;
    try {
      const m = medirCpuRam();
      socket.emit("agent:metrics", { machineId: state.machineId, cpu: m.cpu, ram: m.ram, em: Date.now() });
    } catch {}
  }, 10_000).unref?.();
}

main().catch((err) => { console.error("✗", err.message); process.exit(1); });
