# Nexus RMM — convenções

## Norte do produto
- RMM com acesso remoto NÃO SUPERVISIONADO. Posição: "um GLPI, porém muito melhor"
  — inventário + helpdesk NÃO bastam; o diferencial é controle operacional ao vivo.
- Duas features-âncora (razão de existir):
  1) Tela em tempo real por PC + controle de mouse/teclado (estilo console de VM),
     mais terminal PTY (PowerShell/CMD).
  2) Controle de serviços do Windows ao vivo (start/stop/restart, tipo de init,
     watchdog/self-healing, ações em massa) — substituindo o services.msc.
- A tela em tempo real é âncora E a parte mais difícil (isolamento da Sessão 0):
  helper na sessão ativa (CreateProcessAsUser) + DXGI Desktop Duplication, transporte
  por VNC/noVNC ou WebRTC. NÃO reinventar o protocolo de remote desktop.

## Princípios não-funcionais (valem em todas as fases)
- Operação/manutenção NO-CODE: tudo via painel (tenants, usuários, RBAC, enrollment,
  watchdog, bulk actions, update do agente, auditoria/relatórios). Nunca exigir do
  operador editar arquivo, banco ou rodar comando. (Construir o produto usa código;
  operar e manter, não.)
- Facilidade: deploy em 1 comando (docker compose), migrations automáticas no boot,
  instalador do agente assinado "next-next-finish", auto-update assinado.
- Segurança em camadas (sem prometer "total"): TLS sempre, mTLS, assinatura de comando,
  allowlist de ações, RBAC+MFA, isolamento multi-tenant, auditoria imutável, segredos
  fora do código, binário do agente com Authenticode.
- Confiabilidade: reconexão automática, heartbeat, self-healing, failsafe (fila com
  retry), idempotência por commandId, observabilidade (pino + métricas), backup do Postgres.

## Técnicas
- Node 20+ LTS, TypeScript strict, ESM (type: module), pnpm workspaces.
- `@nexus/protocol` é o contrato único: todo evento/comando/DTO trocado entre
  servidor e agente é definido lá, com Zod, e validado nas duas pontas.
- Multi-tenant: toda tabela de domínio tem tenant_id; toda query é escopada por tenant.
- Auditoria é append-only com cadeia de hash; nunca adicionar UPDATE/DELETE nesses logs.
- Comandos do agente têm sempre commandId (idempotência), expiresAt (anti-replay)
  e signature (verificada no agente).
- Segredos só via env/secret manager; nunca commitar chaves.
- Validar entrada com Zod na borda; logs estruturados com pino incluindo
  tenantId, machineId e commandId quando aplicável.
- `moduleResolution: "Bundler"` + imports sem extensão (compat drizzle-kit; dev via tsx).
- Roadmap: Fase 0 fundação · Fase 1 auth+enrollment+mTLS · Fase 2 PTY ·
  Fase 3 serviços Windows · Fase 4 tela (helper na sessão ativa + VNC/WebRTC) ·
  Fase 5 auto-update assinado + observabilidade.

## Ambiente de desenvolvimento (modelo híbrido)
- **Repositório canônico: local (Windows)**. Desenvolvimento e build de TS aqui.
- **Backend** (Postgres 16, Redis 7, `@nexus/server`, gateway, painel) → roda no
  **servidor Linux** `sis.gmtec.tec.br` (Docker). Deploy via git + docker compose.
- **Agente + captura de tela** → roda na **máquina Windows** (alvo de teste real),
  conectando ao servidor por túnel reverso outbound.
- Acesso ao servidor: ver memória `servidor-gmtec-ssh`.

## Biblioteca de skills (guardrails de engenharia)
- A pasta `skills/` (na raiz do repo, não versionada — ver `.gitignore`) traz a
  biblioteca completa de guias técnicos. Consultar a skill pertinente ao construir
  cada parte. Mais relevantes ao Nexus:
  - Banco: `drizzle-orm-expert`, `postgres-best-practices`, `postgresql-optimization`.
  - Backend: `nodejs-backend-patterns`, `nodejs-best-practices`, `error-handling-patterns`.
  - Segurança/mTLS: `mtls-configuration`, `frontend-security-coder`, `pentest-checklist`.
  - Painel: `nextjs-app-router-patterns`, `react-best-practices`, `ui-design-system`.
  - Agente Windows: `powershell-windows`, `os-scripting`.
  - Testes/CI: `e2e-testing`, `playwright-skill`, `github-actions-templates`.
  - Ops: `linux-shell-scripting`, `observability-engineer`, `prometheus-configuration`.
