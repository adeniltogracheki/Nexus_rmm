#!/usr/bin/env bash
# ===========================================================================
#  Nexus RMM — Instalador do Agente macOS (launchd)
#  Suporte: macOS 12 Monterey+, Intel e Apple Silicon (arm64)
#
#  Uso:
#    curl -sSL https://rmm.gmtec.tec.br/instalar-macos.sh | sudo bash -s -- --token=SEU_TOKEN
#  Ou:
#    sudo bash instalar-macos.sh --token=SEU_TOKEN [--url=https://rmm.gmtec.tec.br]
# ===========================================================================
set -euo pipefail

BASE_URL="https://rmm.gmtec.tec.br"
TOKEN=""
INSTALL_DIR="/opt/nexus-rmm"
PLIST_ID="br.com.nexus-rmm.agente"
PLIST_PATH="/Library/LaunchDaemons/${PLIST_ID}.plist"
NODE_MIN_MAJOR=18

# ── Parse args ──────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --token=*) TOKEN="${arg#*=}" ;;
    --url=*)   BASE_URL="${arg#*=}" ;;
    *) ;;
  esac
done

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${CYAN}[Nexus]${NC} $*"; }
success() { echo -e "${GREEN}[Nexus]${NC} $*"; }
warn()    { echo -e "${YELLOW}[Nexus]${NC} $*"; }
error()   { echo -e "${RED}[Nexus] ERRO:${NC} $*" >&2; exit 1; }

# ── Root check ───────────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && error "Execute como root (sudo bash instalar-macos.sh ...)"

[[ "$(uname -s)" != "Darwin" ]] && error "Este script é para macOS apenas. Use instalar-linux.sh no Linux."

[[ -z "$TOKEN" ]] && error "Informe o token: --token=SEU_TOKEN\n  Gere o token no painel → Máquinas → Cadastrar Nova Máquina."

ARCH=$(uname -m)
info "=== Nexus RMM — Instalador macOS ($ARCH) ==="
info "Servidor: $BASE_URL"

# ── Instalar Node.js ─────────────────────────────────────────────────────────
install_node() {
  info "Verificando Node.js..."

  # Verifica se já existe uma versão adequada
  if command -v node &>/dev/null; then
    local ver
    ver=$(node --version | sed 's/v//' | cut -d. -f1)
    if [[ $ver -ge $NODE_MIN_MAJOR ]]; then
      success "Node.js $(node --version) já instalado em $(which node)."
      return
    fi
    warn "Node.js $(node --version) muito antigo. Instalando versão recente..."
  fi

  # Tenta via Homebrew (mais limpo)
  if command -v brew &>/dev/null; then
    info "Instalando via Homebrew..."
    sudo -u "$(stat -f '%Su' /dev/console)" brew install node@20 2>/dev/null || \
    sudo -u "$(stat -f '%Su' /dev/console)" brew install node 2>/dev/null || true
    # Adiciona ao PATH se necessário
    local brew_prefix
    brew_prefix=$(brew --prefix 2>/dev/null || echo "/opt/homebrew")
    export PATH="$brew_prefix/bin:$PATH"
  fi

  # Se ainda não tem, baixa o PKG oficial
  if ! command -v node &>/dev/null || [[ $(node --version | sed 's/v//' | cut -d. -f1) -lt $NODE_MIN_MAJOR ]]; then
    info "Baixando instalador oficial do Node.js 20 LTS..."
    local node_ver="20.18.0"
    local pkg_arch="x64"
    [[ "$ARCH" == "arm64" ]] && pkg_arch="arm64"
    local pkg_url="https://nodejs.org/dist/v${node_ver}/node-v${node_ver}-darwin-${pkg_arch}.tar.gz"
    local tmp_tar="/tmp/node-nexus.tar.gz"

    curl -fsSL "$pkg_url" -o "$tmp_tar"
    tar -xzf "$tmp_tar" -C /usr/local --strip-components=1
    rm -f "$tmp_tar"
  fi

  command -v node &>/dev/null || error "Falha ao instalar Node.js. Instale manualmente: https://nodejs.org"
  success "Node.js $(node --version) instalado."
}

install_node

NODE_PATH=$(which node)

# ── Criar diretório ──────────────────────────────────────────────────────────
info "Criando diretório $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"

# ── Baixar agente ────────────────────────────────────────────────────────────
info "Baixando agente..."
curl -fsSL "$BASE_URL/agente/agent.js"     -o "$INSTALL_DIR/agent.js"
curl -fsSL "$BASE_URL/agente/package.json" -o "$INSTALL_DIR/package.json" 2>/dev/null || \
  echo '{"name":"nexus-agente","version":"1.0.0","type":"commonjs"}' > "$INSTALL_DIR/package.json"

# ── Dependências ─────────────────────────────────────────────────────────────
info "Instalando dependências npm..."
cd "$INSTALL_DIR"

# Dependências principais
npm install socket.io-client ws --save --prefer-offline --loglevel=error 2>/dev/null || true

# node-pty (terminal interativo com PTY real — backspace, cores, autocomplete)
info "Instalando node-pty (terminal interativo)..."
npm install @homebridge/node-pty-prebuilt-multiarch --save --prefer-offline --loglevel=error 2>/dev/null || \
  warn "node-pty não instalado — terminal usará modo básico (sem cores/autocomplete). Não afeta monitoramento."

# ── Configurar env ───────────────────────────────────────────────────────────
cat > "$INSTALL_DIR/.env" <<EOF
NEXUS_API_URL=$BASE_URL
NEXUS_GATEWAY_URL=${BASE_URL/https/wss}:8443
NEXUS_ENROLL_TOKEN=$TOKEN
AGENT_STATE=$INSTALL_DIR/agent-state.json
EOF
chmod 600 "$INSTALL_DIR/.env"

# ── Remover serviço anterior se existir ────────────────────────────────────
if [[ -f "$PLIST_PATH" ]]; then
  warn "Removendo instalação anterior..."
  launchctl unload -w "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"
fi

# ── Criar LaunchDaemon plist ────────────────────────────────────────────────
info "Criando serviço launchd..."
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_ID}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${INSTALL_DIR}/agent.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>NEXUS_API_URL</key>      <string>${BASE_URL}</string>
    <key>NEXUS_GATEWAY_URL</key>  <string>${BASE_URL/https/wss}:8443</string>
    <key>NEXUS_ENROLL_TOKEN</key> <string>${TOKEN}</string>
    <key>AGENT_STATE</key>        <string>${INSTALL_DIR}/agent-state.json</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/var/log/nexus-agente.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/nexus-agente-error.log</string>

  <key>ThrottleInterval</key>
  <integer>15</integer>
</dict>
</plist>
EOF

chmod 644 "$PLIST_PATH"
chown root:wheel "$PLIST_PATH"

# ── Carregar serviço ─────────────────────────────────────────────────────────
launchctl load -w "$PLIST_PATH"
sleep 3

if launchctl list | grep -q "$PLIST_ID"; then
  success "✅ Agente Nexus RMM rodando como LaunchDaemon!"
  echo ""
  echo -e "  ${CYAN}Logs:${NC}    tail -f /var/log/nexus-agente.log"
  echo -e "  ${CYAN}Parar:${NC}   sudo launchctl unload $PLIST_PATH"
  echo -e "  ${CYAN}Iniciar:${NC} sudo launchctl load -w $PLIST_PATH"
  echo ""
  info "A máquina aparecerá no painel em até 30 segundos."
else
  warn "Serviço instalado. Verificando logs..."
  echo ""
  tail -n 20 /var/log/nexus-agente-error.log 2>/dev/null || true
fi
