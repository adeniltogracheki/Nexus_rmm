#!/usr/bin/env bash
# ===========================================================================
#  Nexus RMM — Instalador do Agente Linux (systemd)
#  Suporte: Ubuntu 20+, Debian 10+, RHEL/Rocky/AlmaLinux 8+, Fedora 38+
#
#  Uso:
#    curl -sSL https://rmm.gmtec.tec.br/instalar-linux.sh | sudo bash -s -- --token=SEU_TOKEN
#  Ou:
#    sudo bash instalar-linux.sh --token=SEU_TOKEN [--url=https://rmm.gmtec.tec.br]
# ===========================================================================
set -euo pipefail

BASE_URL="https://rmm.gmtec.tec.br"
TOKEN=""
INSTALL_DIR="/opt/nexus-rmm"
SERVICE_NAME="nexus-agente"
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
[[ $EUID -ne 0 ]] && error "Execute como root (sudo bash instalar-linux.sh ...)"

[[ -z "$TOKEN" ]] && error "Informe o token: --token=SEU_TOKEN\n  Gere o token no painel → Máquinas → Cadastrar Nova Máquina."

info "=== Nexus RMM — Instalador Linux ==="
info "Servidor: $BASE_URL"

# ── Detectar distro ──────────────────────────────────────────────────────────
detect_pkg_manager() {
  if command -v apt-get &>/dev/null; then echo "apt"
  elif command -v dnf &>/dev/null; then echo "dnf"
  elif command -v yum &>/dev/null; then echo "yum"
  elif command -v pacman &>/dev/null; then echo "pacman"
  elif command -v zypper &>/dev/null; then echo "zypper"
  else echo "unknown"; fi
}

PKG_MGR=$(detect_pkg_manager)
info "Gerenciador de pacotes detectado: $PKG_MGR"

# ── Instalar Node.js ─────────────────────────────────────────────────────────
install_node() {
  info "Verificando Node.js..."
  if command -v node &>/dev/null; then
    local ver
    ver=$(node --version | sed 's/v//' | cut -d. -f1)
    if [[ $ver -ge $NODE_MIN_MAJOR ]]; then
      success "Node.js $(node --version) já instalado."
      return
    fi
    warn "Node.js $(node --version) muito antigo. Instalando versão recente..."
  fi

  case "$PKG_MGR" in
    apt)
      info "Instalando Node.js via NodeSource (LTS)..."
      apt-get update -qq
      apt-get install -y curl ca-certificates gnupg
      mkdir -p /etc/apt/keyrings
      curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
      echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list
      apt-get update -qq
      apt-get install -y nodejs
      ;;
    dnf|yum)
      info "Instalando Node.js via NodeSource (LTS)..."
      "$PKG_MGR" install -y curl
      curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
      "$PKG_MGR" install -y nodejs
      ;;
    pacman)
      pacman -Sy --noconfirm nodejs npm
      ;;
    zypper)
      zypper refresh
      zypper install -y nodejs20 npm20
      ;;
    *)
      warn "Gerenciador de pacotes não reconhecido. Tentando instalar Node.js via script oficial..."
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      ;;
  esac

  command -v node &>/dev/null || error "Falha ao instalar Node.js."
  success "Node.js $(node --version) instalado."
}

install_node

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
# Usamos a fork homebridge que distribui binários pré-compilados para Linux x64 e arm64,
# evitando a necessidade de python3/make/gcc para compilar do zero.
info "Instalando node-pty (terminal interativo)..."
NODE_VER=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
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

# ── Criar serviço systemd ─────────────────────────────────────────────────────
info "Criando serviço systemd..."
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Nexus RMM — Agente de monitoramento
Documentation=$BASE_URL
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/.env
ExecStart=$(which node) $INSTALL_DIR/agent.js
Restart=always
RestartSec=15
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nexus-agente
KillMode=mixed
TimeoutStopSec=15

# Segurança básica (não usa namespacing pois precisa de /proc e redes)
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

# ── Ativar e iniciar ─────────────────────────────────────────────────────────
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

sleep 3

if systemctl is-active --quiet "$SERVICE_NAME"; then
  success "✅ Agente Nexus RMM rodando como serviço systemd!"
  echo ""
  echo -e "  ${CYAN}Logs:${NC}    journalctl -u $SERVICE_NAME -f"
  echo -e "  ${CYAN}Status:${NC}  systemctl status $SERVICE_NAME"
  echo -e "  ${CYAN}Parar:${NC}   systemctl stop $SERVICE_NAME"
  echo ""
  info "A máquina aparecerá no painel em até 30 segundos."
else
  warn "O serviço foi instalado mas pode estar demorando para conectar."
  echo ""
  echo "  Verifique os logs:"
  echo "  journalctl -u $SERVICE_NAME -n 50 --no-pager"
  echo ""
  journalctl -u "$SERVICE_NAME" -n 20 --no-pager 2>/dev/null || true
fi
