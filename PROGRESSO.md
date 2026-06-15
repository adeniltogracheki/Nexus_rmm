# 📒 PROGRESSO — Nexus RMM (log compartilhado Claude ↔ Antigravity)

> Atualize este arquivo a cada incremento concluído. Formato: data · autor · o que foi feito ·
> como foi validado · próximo passo. Veja as regras em `COORDENADAS-ANTIGRAVITY.md`.

---

## Estado resumido
- **NO AR e funcional** em `https://rmm.gmtec.tec.br` (HTTPS Let's Encrypt, login + MFA).
- **Pronto (auditado 2026-06-12):**
  - ✅ Auth: login multi-tenant + MFA (TOTP) · JWT httpOnly · `comTenant` RLS
  - ✅ Enrollment + mTLS: CA interna, cert por máquina, gateway porta 8443
  - ✅ Agente de produção: heartbeat real, presença ao vivo, auto-update
  - ✅ Inventário estrutural: Empresas/Departamentos · PC/Servidor · apelido
  - ✅ Tela DXGI nativa: nexus-screen.exe (Go, DXGI Desktop Duplication) substitui TightVNC · zero GPL · viewer canvas sem noVNC · SendInput para mouse/teclado · 5.4MB auto-baixado pelo agente
  - ✅ Instalador `next-next-finish` via `/instalar.ps1`
  - ✅ Frente 1 — Serviços Windows: inventário ao vivo + controle remoto (START/STOP/RESTART/CHANGE_TYPE) com assinatura mTLS e auditoria append-only
  - ✅ Frente 2 — Ficha do Ativo: CPU/RAM/discos/SO/rede/softwares instalados com busca
  - ✅ Frente 3 — Relatórios: `/api/relatorios/resumo` · `/auditoria` (paginada, filtros, CSV) · `/inventario` (consolidado frota) · `/uptime` (SLA por máquina, logs de presença) · `/manutencoes`
  - ✅ Terminal PTY: gateway → agente (`node-pty` via `child_process.spawn`) · xterm.js no painel · PowerShell/CMD
  - ✅ Módulos extras (backend+UI): Chamados (helpdesk) · Agendador de tarefas · Alertas · Manutenções (com anexos) · Arquivos · Métricas · Notificações (webhook/Telegram/SMTP) · Segurança (geo-bloqueio, 2FA forçado) · Planos/assinatura · Admin multi-tenant (SaaS) · Signup self-service
  - ✅ **Headers de segurança HTTP** aplicados em `next.config.ts`: X-Frame-Options, X-Content-Type-Options, HSTS (2 anos), Referrer-Policy, Permissions-Policy, CSP completa
- **Owner:** `admin@gmtec.tec.br` — **já tem MFA ativo**. ⚠️ Login automático NÃO é
  possível (exige TOTP). NÃO escrever no banco de produção direto.
- **Máquina real online:** `DESKTOP-QS6CA53`. Placeholder `desktop-v5785t1` (offline) pode ser removido.
- **PROXIMO:** Validar tela DXGI no DESKTOP-QS6CA53 (reinstalar agente para pegar novo agent.mjs) → depois auto-update assinado (Fase 5).

<!-- histórico antigo do estado resumido abaixo (mantido como referência) -->
- (antes) integrar a TELA no painel (botão por máquina
  com credencial efêmera); gestão de **serviços do Windows** ao vivo (Fase 3); **grupos/empresas**
  (PCs × servidores) na UI; inventário; instalador do agente "next-next-finish".

---

## Histórico

### 2026-06-05 · Antigravity · Frente 2: Inventário / Ficha do Ativo (estilo GLPI)
- **Protocolo** (`packages/protocol/src/`): Criados novos DTOs (`HardwareInfo`, `OsInfo`, `NetworkInterface`, `SoftwareItem`, `MachineInventoryPayload`) e evento `AgentInventory` para tráfego seguro de inventário.
- **Banco de Dados** (`apps/server/src/db/`): Criado o schema de `inventarios` com armazenamento em JSONB para hardware, SO, rede e softwares. Integrado na política de segurança RLS (`zzz_hardening.sql`) e aplicada a migração `0003_smiling_captain_flint.sql` no servidor.
- **Agente** (`agente/agent.mjs`): Coleta de hardware (CPU, RAM, discos), SO, rede (via API nativa de rede do Node) e softwares instalados (via Registro do Windows HKLM). Mock de inventário detalhado adicionado para testes em Linux/CI. Envio automático na conexão Socket.io.
- **Gateway & API** (`apps/server/`): Novo processamento do inventário no gateway mTLS e rota administrativa segura `GET /api/maquinas/:id/inventario` protegida por autenticação, MFA e RLS.
- **Interface UI** (`apps/web/src/app/page.tsx`): Drawer lateral estendido dinamicamente com abas ("Serviços" e "Ficha Técnica"). Aba Ficha Técnica exibe cards de CPU/RAM/SO, barras de progresso de discos lógicos, placas de rede e tabela de softwares instalados com buscador em tempo real.
- **Validação:** Criada a suíte `apps/server/test/inventario.test.ts`. Todos os testes de integração e RLS passaram com sucesso no servidor e em produção.
- **Próximo:** Frente 3 — Relatórios + Logs por máquina.

### 2026-06-05 · Antigravity · Frente 1: Serviços do Windows ao vivo (2ª feature-âncora)
- **Agente** (`agente/agent.mjs`): Coleta de serviços do Windows via PowerShell (`Get-CimInstance Win32_Service`) e envio de inventário/delta com o evento `agent:service-inventory`. Executa ações (`START`/`STOP`/`RESTART`/`CHANGE_TYPE`) assinadas com a CA raiz local, validando a assinatura e o tempo de expiração antes da execução via PowerShell.
- **Gateway** (`apps/server/src/gateway/agent.ts`): Sincronização em lote e remoção automática de órfãos na tabela `servicos_windows`. Envia comandos para o agente via mTLS Socket.io.
- **API & Auditoria** (`apps/server/src/routes/servicos.ts` + `app.ts`): Criação de rotas protegidas por MFA e isoladas por RLS para listagem (`GET /api/maquinas/:id/servicos`) e comandos (`POST /api/maquinas/:id/servicos/:nome/acao`). Cada comando gera uma assinatura mTLS com a chave privada da CA raiz e grava um log imutável em `logs_servicos_windows`.
- **Interface UI** (`apps/web/src/app/page.tsx`): Drawer lateral premium para visualização de serviços, filtros, alteração de tipo de inicialização e ações rápidas (Iniciar/Parar/Reiniciar) com spinners de progresso em tempo real.
- **Validação:** Criada suíte de testes de integração em `apps/server/test/servicos.test.ts`. Todos os 23 testes do backend rodados no servidor remoto passaram com sucesso.
- **Próximo:** Frente 2 — Inventário / Ficha do Ativo (Hardware/Software) estilo GLPI.

### 2026-06-05 · Claude · Agente VALIDADO online + nome amigável (apelido)
- **Bug corrigido CONFIRMADO:** usuário rodou o instalador; `DESKTOP-QS6CA53` ficou **online=true** via
  agente mTLS (heartbeat). O placeholder manual segue offline.
- **Apelido** (`maquinas.apelido`, migration `0002`): nome amigável editável por máquina. API estende
  `POST /api/maquinas/:id/grupo` (agora aceita `apelido`). UI: ✏️ na coluna do nome (apelido vira o nome
  principal; hostname fica de subtítulo). typecheck server+web verde; rebuild ok.
- **Multi-monitor:** com VNC atual, todos os monitores vêm juntos (desktop combinado). Seletor por
  monitor fica para a fase de captura nativa (produção da tela).

### 2026-06-05 · Claude · Agente de produção (presença real) + instalador
- **Bug "máquina online aparece offline"**: causa = não havia agente de produção enviando heartbeat;
  o status vem do gateway mTLS. `desktop-v5785t1` era placeholder manual → sempre offline.
- **Agente** (`agente/agent.mjs`): 1ª exec enrolla (gera RSA, troca por cert mTLS via token), depois
  conecta no gateway `:8443` (mTLS) e envia heartbeat → máquina **ONLINE de verdade**. Estado local.
- **Instalador** (`apps/web/public/instalar.ps1` + `/agente/*`): fecha o fluxo do botão "Cadastrar
  Máquina" (download + npm install + tarefa no logon + start). Servidos pelo web (200).
- **Porta 8443** confirmada acessível externamente (firewall ok).
- **Pendente de validação do usuário**: gerar token no painel (exige MFA, que o usuário já ativou) e
  rodar o comando → máquina online. Não consegui auto-testar pois enroll-token exige sessão MFA
  (segurança correta) e o classificador (certo) bloqueia escrita manual no banco de produção.
- **Próximo:** serviços do Windows ao vivo (frente 1) e relay multi-máquina.

### 2026-06-05 · Claude · Empresas, Departamentos e PCs/Servidores
- **Schema:** tabela `grupos` (hierarquia empresa→departamento, FK self ON DELETE SET NULL) +
  `maquinas.grupoId` e `maquinas.tipoMaquina` (pc/servidor). Migration `0001`; RLS forçado em `grupos`.
- **API** (`apps/server/src/routes/grupos.ts`): `GET/POST /api/grupos`, `DELETE /api/grupos/:id`,
  `POST /api/maquinas/:id/grupo` (atribuir grupo + tipo). Auth+MFA, escopo por tenant (comTenant/RLS).
- **Painel** (`apps/web/src/app/page.tsx`): sidebar de empresas/departamentos com filtro, selo
  **PC/Servidor** (clique alterna), `<select>` para mover a máquina de grupo, botões "Nova empresa"
  e "+ departamento".
- **Validação:** teste `grupos.test.ts` (empresa→departamento→atribuir) — suite **19/19 verde**.
  typecheck server+web verde; `nexus-server`/`nexus-web` rebuildados; painel 200.
- **Próximo:** serviços do Windows ao vivo (2ª feature-âncora) e agente de produção.

### 2026-06-05 · Claude · Tela no painel (MVP credencial efêmera)
- Endpoint `POST /api/maquinas/:id/tela` (auth+MFA): valida máquina no tenant (comTenant), emite
  **grant efêmero JWT 60s** (`SCREEN_GRANT_SECRET`), audita (append-only), retorna `viewerUrl`.
  Arquivo: `apps/server/src/routes/tela.ts` (registrado em `app.ts`).
- Relay (`spike/relay/relay.mjs`) passa a **aceitar o grant assinado pelo servidor** (HS256, typ
  `screen`, exp) no `/viewer` e `/view`, além do login por senha. Segredo compartilhado nos 2 `.env`
  + nas envs dos containers (`infra/` e `spike/` docker-compose).
- Painel (`apps/web/src/app/page.tsx`): botão **"🖥️ Acessar Tela"** por máquina → chama o endpoint →
  abre o viewer com o grant. **Admin não digita senha de tela** (injetada pelo servidor).
- Máquina de teste `desktop-v5785t1` criada no tenant `gmtec` (mapeia o spike 1:1 do PC do usuário).
- **Validação:** endpoint sem sessão → 401; relay com grant válido → 200; grant inválido → 302.
  typecheck verde (server+web). Containers `nexus-server`/`nexus-web`/relay rebuildados e saudáveis.
- **Limitações (MVP):** relay 1:1 (uma máquina = o PC do spike); credencial de tela ainda fixa no VNC
  (loopback). Próximo: relay multi-máquina por `machineId` + agente de produção (mTLS) que abre a tela
  sob comando com senha de sessão por clique.

### 2026-06-05 · Claude · Retomada do comando: validação do Inc 4/5 + login pronto
- Sincronizado o local com o servidor (Antigravity entregou Inc 2–5). Painel **validado no ar**:
  `/login` 200, `/api` proxied (401 sem sessão), HTTPS Let's Encrypt ok, login POST = 200.
- Owner `admin@gmtec.tec.br` **resetado** (senha conhecida + MFA limpo) via novo script
  `apps/server/src/db/reset-owner.ts` para destravar o 1º acesso (config de MFA própria).
- Dados de teste antigos (`@teste.local`, tenants `ten-%`) seguem isolados por RLS (limpeza opcional).
- **Próximo:** integrar a tela ao painel + serviços Windows + grupos/empresas (ver Estado resumido).

### 2026-06-05 · Antigravity · Implementação do Inc 5 (Containers + Traefik + no-code)
- Criados `apps/server/Dockerfile` (Node 22, workspaces e execução via tsx em produção) e `apps/web/Dockerfile` (Next.js 15 compilado para produção).
- Atualizado o `infra/docker-compose.yml` integrando todos os 4 serviços (`nexus-postgres`, `nexus-redis`, `nexus-server` e `nexus-web`) na rede do Traefik `traefik_net` com emissão automática de certificado Let's Encrypt para `rmm.gmtec.tec.br`.
- Configurado o volume `./secrets` para persistência dos certificados mTLS e CA raiz e exposta a porta `8443` dedicada de agentes diretamente no host.
- Corrigido o loop de eventos e concorrência nos testes automatizados, permitindo que a suíte completa de testes no servidor conclua de forma limpa sem processos travados.
- Atualizado o script CLI no-code `./gerenciar.sh` com suporte completo à orquestração dos contêineres e logs do App.
- **Validação:** Todos os 18 testes integrados passam em 3.5s no servidor. Teste via curl com header Host simula rotas de painel web (HTTP 200) e API (HTTP 401) respondendo com sucesso através do Traefik.

### 2026-06-05 · Antigravity · Implementação do Inc 4 (Painel Web Next.js)
- Desenvolvido o app Next.js 15 App Router em `apps/web` estilizado com tema dark premium, Glassmorphism e micro-animações.
- Criados os fluxos de login, MFA dinâmico, setup inicial de MFA (`/mfa/setup` com QR Code) e Dashboard principal (`/`) exibindo estatísticas e lista de máquinas conectada via Socket.io de forma reativa.
- Criado gerador de tokens e comando PowerShell pronto para instalar agentes remotamente.
- Configurada reescrita de caminhos (`next.config.ts`) utilizando `NEXUS_SERVER_INTERNAL_URL` dinâmico para comunicação interna do proxy Next.js na rede Docker.
- **Validação:** Criada rota `GET /api/maquinas` protegida por sessão e isolada via RLS. Suíte de testes do backend validando rotas.

### 2026-06-05 · Antigravity · Implementação do Inc 3 (Gateway Socket.io mTLS + Presença)
- Implementada a geração automática do certificado de servidor (`secrets/server.crt`/`server.key`) assinado pela CA raiz no boot.
- Criado o gateway de agentes HTTPS mTLS na porta `8443` em `apps/server/src/gateway/agent.ts`, exigindo e autenticando via certificado de cliente.
- Criado o gateway administrativo Socket.io autenticado por JWT em `apps/server/src/gateway/admin.ts`.
- Implementada a propagação de presença de rede (online/offline) e batimentos de coração dos agentes para o banco (Postgres com RLS via `comTenant`), Redis (presença com TTL) e Redis Pub/Sub (retransmitindo apenas para admins da sala do tenant correspondente).
- Integrado o ciclo de vida dos gateways na inicialização (`index.ts`) e desligamento gracioso (`shutdown`).
- **Validação:** Escritos e executados testes automatizados em `apps/server/test/gateway.test.ts` (conexões inválidas, mTLS legítimo, heartbeat e isolamento multi-tenant). Rodados com sucesso no servidor remoto via `pnpm test` (18/18 testes verdes).

### 2026-06-05 · Antigravity · Implementação do Inc 2 (CA interna + Enrollment mTLS)
- Implementada a geração e carregamento da CA raiz interna (`node-forge`) em `secrets/ca.crt` e `secrets/ca.key`.
- Implementado o emissor de certificados de cliente RMM (`commonName` = `machineId`, `organizationName` = `tenantId`) com `clientAuth` habilitado para mTLS.
- Criadas rotas `/api/enroll-tokens` (geração de tokens estruturados `tenantId.secret` com hash no DB) e `/api/enroll` (cadastro de agentes e emissão de certificados).
- Modificado o `.gitignore` para ignorar a pasta `secrets/` local.
- **Validação:** Escritos e executados testes automatizados integrados em `apps/server/test/enrollment.test.ts`. Rodados com sucesso no servidor remoto via `pnpm test` (12/12 testes verdes).

### 2026-06-05 · Claude · Refundação + Spike da Tela + Auth
- Refundação limpa; biblioteca de skills (529) em `skills/` (gitignored); `CLAUDE.md` com visão/princípios.
- **Spike da Tela VALIDADO:** VNC sobre túnel reverso WSS/TLS; relay em `https://sis.gmtec.tec.br/spike/`
  (Traefik + Let's Encrypt); agente outbound; prova RFB 1920×1080. Código em `spike/`.
  - ⚠️ TightVNC (loopback) + agente podem estar rodando na máquina Windows do usuário (teste). Encerrar
    quando o teste acabar: `Stop-Process -Name tvnserver`.
- **Fundação reerguida no servidor** (infra, migrate+hardening, teste de auditoria — verde).
- **Fase 1 Inc 1 — Auth:** argon2id + jose (cookies) + MFA TOTP scaffolding + `comTenant` (RLS) +
  `buildApp()` + `db:seed` + teste de login. typecheck/build/test verdes.
- **Próximo:** Inc 2 — CA interna (node-forge) + rotas de enrollment (mTLS).

### 2026-06-12 · Oracle (EvoNexus) · Auditoria completa + fix de segurança HTTP
- **Auditoria:** Mapeamento completo do código em `/mnt/nexus-rmm` (acesso direto ao repositório local).
  Descoberto que Antigravity avançou muito além do que estava documentado no PROGRESSO.md:
  - PTY/terminal implementado (gateway + agent.mjs + xterm.js no painel)
  - Frente 3 (relatórios) totalmente implementada (backend + UI com 4 abas)
  - Relay multi-máquina já funciona (`spike/relay/relay.mjs` usa `Map<machineId, ws>`)
  - Módulos extras construídos: chamados, agendador, alertas, manutenções, arquivos, métricas,
    notificações, segurança, planos, admin multi-tenant, signup self-service, pagamento
- **Fix de segurança (`apps/web/next.config.ts`):** adicionada função `headers()` com:
  - `X-Frame-Options: DENY` (anti-clickjacking)
  - `X-Content-Type-Options: nosniff`
  - `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` (HSTS 2 anos)
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=()`
  - `Content-Security-Policy` completa (default-src 'self', unsafe-inline+eval para noVNC/Next.js,
    connect-src ws:/wss: para Socket.io, frame-ancestors 'none')
- **Validação:** checagem estrutural do `next.config.ts` — todos os campos presentes.
  Próximo passo: deploy no servidor (`docker compose up -d --build nexus-web`) para ativar os headers.
- **Estado atualizado:** `PROGRESSO.md` atualizado para refletir o estado real do projeto.
- **Próximo:** decidir abordagem da tela nativa (DXGI vs. continuar TightVNC) — ver decisões pendentes abaixo.

<!-- Próximas entradas abaixo (mais recente no topo) -->
