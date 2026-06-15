#!/bin/bash
# ============================================================================
#  Nexus RMM — Menu de operação (sem precisar programar)
#  Como usar:  ./gerenciar.sh   e escolha um número.
# ============================================================================
set -u

# Vai para a pasta do projeto (onde este script está), não importa de onde rodou.
cd "$(dirname "$0")"

PROJETO="Nexus RMM"

pausar() { echo; read -rp "Pressione ENTER para voltar ao menu..." _; }

subir() {
  echo "→ Subindo infraestrutura e aplicação completa (Docker)..."
  docker compose --env-file .env -f infra/docker-compose.yml up --build -d
  echo "✓ Pronto. Veja o status na opção 3."
}

subir_infra_dev() {
  echo "→ Subindo apenas banco de dados e cache para desenvolvimento local..."
  docker compose --env-file .env -f infra/docker-compose.yml up -d postgres redis
  echo "✓ Pronto. Banco de dados e cache iniciados."
}

parar() {
  echo "→ Parando todos os serviços..."
  docker compose --env-file .env -f infra/docker-compose.yml down
  echo "✓ Parado."
}

status() {
  echo "=== Containers do $PROJETO ==="
  docker compose --env-file .env -f infra/docker-compose.yml ps \
    --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
}

atualizar_banco() {
  echo "→ Aplicando atualizações de estrutura no banco (migrations + segurança)..."
  pnpm db:migrate && echo "✓ Banco atualizado."
}

logs() {
  echo "(Mostrando todos os logs — pressione CTRL+C para sair)"
  sleep 1
  docker compose --env-file .env -f infra/docker-compose.yml logs -f
}

logs_app() {
  echo "(Mostrando logs da Aplicação Server/Web — pressione CTRL+C para sair)"
  sleep 1
  docker compose --env-file .env -f infra/docker-compose.yml logs -f nexus-server nexus-web
}

reiniciar_app() {
  echo "→ Recriando e reiniciando apenas os contêineres da App..."
  docker compose --env-file .env -f infra/docker-compose.yml up -d --build nexus-server nexus-web
  echo "✓ Aplicação reiniciada."
}

testar_saude() {
  echo "→ Subindo o servidor por alguns segundos para testar a saúde..."
  pnpm --filter @nexus/protocol build >/dev/null 2>&1
  nohup pnpm --filter @nexus/server start >/tmp/nexus-saude.log 2>&1 &
  local pid=$!
  for _ in $(seq 1 20); do
    sleep 1
    curl -sf -o /dev/null http://localhost:4000/healthz 2>/dev/null && break
  done
  echo "--- /healthz ---"; curl -s -w "\n(HTTP %{http_code})\n" http://localhost:4000/healthz
  echo "--- /readyz ---"; curl -s -w "\n(HTTP %{http_code})\n" http://localhost:4000/readyz
  kill "$pid" >/dev/null 2>&1
  echo "✓ Teste concluído (servidor encerrado)."
}

backup() {
  mkdir -p backups
  local arq="backups/nexus_$(date +%Y%m%d_%H%M%S).sql"
  echo "→ Gerando backup do banco em: $arq"
  if docker exec nexus-postgres pg_dump -U postgres nexus > "$arq" 2>/dev/null; then
    echo "✓ Backup salvo: $arq ($(du -h "$arq" | cut -f1))"
  else
    echo "✗ Falhou. O banco está no ar? (opção 8 para subir)"
    rm -f "$arq"
  fi
}

atualizar_sistema() {
  echo "→ Atualizando o sistema (código + dependências + banco)..."
  git pull && pnpm install && pnpm build && pnpm db:migrate
  echo "✓ Sistema atualizado."
}

menu() {
  clear
  echo "========================================"
  echo "   $PROJETO — Painel de operação"
  echo "========================================"
  echo "  1) Subir infraestrutura e App completa"
  echo "  2) Parar tudo (App + Banco + Cache)"
  echo "  3) Ver status"
  echo "  4) Atualizar estrutura do banco (Migrate)"
  echo "  5) Ver logs do App (Server e Web)"
  echo "  6) Ver logs de tudo (Bancos + App)"
  echo "  7) Reiniciar/Rebuildar apenas a App"
  echo "  8) Subir apenas Banco e Cache (para testes locais)"
  echo "  9) Fazer backup do banco"
  echo " 10) Atualizar o sistema local (Git Pull + Rebuild)"
  echo "  0) Sair"
  echo "----------------------------------------"
  read -rp "Escolha uma opção: " opcao
  case "$opcao" in
    1) subir; pausar ;;
    2) parar; pausar ;;
    3) status; pausar ;;
    4) atualizar_banco; pausar ;;
    5) logs_app ;;
    6) logs ;;
    7) reiniciar_app; pausar ;;
    8) subir_infra_dev; pausar ;;
    9) backup; pausar ;;
    10) atualizar_sistema; pausar ;;
    0) echo "Até logo!"; exit 0 ;;
    *) echo "Opção inválida."; pausar ;;
  esac
}

while true; do menu; done
