# 🧭 COORDENADAS — Nexus RMM (Claude no comando → Antigravity executa)

> **Propósito:** este é o contrato único entre o **Claude** (arquiteto/comando) e a
> **Antigravity** (executora quando os tokens do Claude estiverem em pausa). Siga-o à risca.
> O objetivo é avançar o projeto **sem bagunçar nada** e **sem fugir das decisões já tomadas**.
> Em caso de dúvida ou conflito: **PARE e pergunte ao usuário** — não improvise arquitetura.

---

## 0. REGRAS DE OURO (não negociáveis)

1. **Idioma:** responder sempre em **português (pt-BR)**.
2. **Não quebrar o que já funciona.** Fase 0 (fundação) e o Spike da Tela estão validados.
   Rode `pnpm typecheck`, `pnpm build` e `pnpm test` ANTES de qualquer commit/deploy.
3. **Repo canônico = LOCAL (Windows):** `G:\Projetos_com_IA\AntigravitSkills\Sistema_\nexus-rmm`.
   Branch `main`. O servidor Linux é **alvo de deploy**, não fonte da verdade.
4. **Segredos nunca no git.** `.env`, chaves, `secrets/`, tokens → ficam fora do versionamento
   (ver `.gitignore`). Nunca imprima senha/token no chat nem em logs.
5. **Ações destrutivas/sensíveis** (apagar dados, mexer em DNS/firewall, instalar coisas na
   máquina do usuário, expor portas) → **confirmar com o usuário antes**.
6. **Uma feature por vez**, em incrementos verificáveis (ver §6). Commit pequeno e descritivo.
7. **No-code de operação** é requisito do produto: o admin opera tudo pelo painel; ao construir,
   sempre pense "como o usuário faz isso sem terminal?".
8. **Mantenha este arquivo e o `PROGRESSO.md` atualizados** a cada incremento (estado + decisões).
9. Toda mudança de **arquitetura** (stack, protocolo, segurança) precisa de OK do usuário.
10. Mensagens de commit terminam com `Co-Authored-By:` da IA que fez (ver §4).

---

## 1. ESTADO ATUAL (o que está pronto e validado)

| Bloco | Status | Onde |
|---|---|---|
| Fundação (Fase 0): monorepo pnpm, `@nexus/protocol`, `@nexus/server` Fastify, schema multi-tenant, **auditoria imutável** (cadeia de hash + RLS + REVOKE), `/healthz` `/readyz`, Docker Postgres/Redis | ✅ validado no servidor | `apps/server`, `packages/protocol`, `infra/` |
| **Spike da Tela** (feature-âncora #1 de-riscada): VNC sobre **túnel reverso WSS/TLS**, relay atrás do Traefik em `https://sis.gmtec.tec.br/spike/`, agente outbound, noVNC | ✅ validado (frame real 1920×1080) | `spike/` |
| **Fase 1 Inc 1 — Auth**: login + JWT (cookies httpOnly) + MFA TOTP (scaffolding) + `comTenant` (RLS por tenant) + `db:seed` + `buildApp()` + teste | ✅ typecheck/build/test verdes | `apps/server/src/auth`, `routes/auth.ts`, `db/tenant.ts` |

**Próximo:** Fase 1 Inc 2 → 3 → 4 → 5 (ver §6). A Fase 1 entrega o **produto navegável**
(login + painel). Depois disso, decidir a produção da Tela (DXGI/WebRTC vs VNC bundle).

Roadmap do brief: Fase 0 fundação · **Fase 1 auth+enrollment+mTLS+gateway+painel** · Fase 2 PTY ·
Fase 3 serviços Windows · Fase 4 tela produção · Fase 5 auto-update+observabilidade.
Brief completo no servidor: `/home/opc/SIGU/Sistema_PCs/NEXUS_RMM_Fase0_Brief_ClaudeCode.md`.

---

## 2. AMBIENTE E ACESSOS

- **Local (Windows):** Node 24, pnpm 11 (via corepack), Docker Desktop (às vezes parado), git.
  É também o **alvo de teste do agente/tela** (Windows-only).
- **Servidor (deploy):** `opc@sis.gmtec.tec.br` (IP `163.176.169.89`), Oracle Linux 9, Docker +
  Compose, Node 22, pnpm 10. Acesso SSH:
  `ssh -i "/c/Users/Waser/.gemini/antigravity/scratch/SRV-VM-BRAZIL.pem" -o StrictHostKeyChecking=no opc@sis.gmtec.tec.br`
  (rodar `chmod 600` na chave antes, no git-bash).
- **Repo no servidor:** `/home/opc/SIGU/Sistema_PCs/nexus-rmm` (com `.env` e `spike/.env` que
  NÃO estão no git — não sobrescrever sem backup).
- **Traefik** roda no servidor (rede docker `traefik_net`), portas 80/443, com **Let's Encrypt**
  (resolver `myresolver`, http-challenge). Hosts já servidos: `sis`, `ia`, `suporte`, `acessodns`,
  `guardiam` (.gmtec.tec.br).
- **DNS:** `gmtec.tec.br` é **Cloudflare** (NÃO o Technitium do servidor). Registros DNS-only
  (grey cloud) → IP de origem. Sem acesso ao Cloudflare via API; o usuário adiciona registros pelo painel.
- **Portainer** (`:9000`/`:9443`) e **n8n** (`:5678`) existem para operação visual.

---

## 3. ARQUITETURA E DECISÕES TRAVADAS (NÃO DESVIAR)

- **Stack:** Node 20+ LTS, **TypeScript strict, ESM**, pnpm workspaces. Fastify 5, Drizzle ORM 0.36
  (+ drizzle-kit 0.28), Postgres 16, Redis 7, Zod, pino.
- **`moduleResolution: "Bundler"` + imports SEM extensão** (drizzle-kit 0.28 não resolve `.js`→`.ts`).
  Dev/migrate/test rodam via **tsx** (com `--env-file=../../.env`).
- **`@nexus/protocol`** é o **contrato único** (eventos socket.io, comandos Zod, DTOs, auth). Seus
  `exports` apontam para `src/` (resolve sem build). Tudo trocado servidor↔agente é definido lá.
- **Multi-tenant:** toda tabela de domínio tem `tenant_id`. RLS forçado nas tabelas de DADOS
  (maquinas, tokens_enrollment, sessoes_remotas, logs); acesso via helper **`comTenant(tenantId, fn)`**
  (`apps/server/src/db/tenant.ts`) que faz `SET app.tenant_id`. **`tenants` e `usuarios` ficam FORA
  do RLS** (login é busca cross-tenant por email).
- **Auditoria** = append-only com cadeia de hash (trigger em `logs_servicos_windows`). NUNCA adicionar
  UPDATE/DELETE nesses logs. Hardening em `apps/server/drizzle/zzz_hardening.sql` (idempotente).
- **Auth:** argon2id (`@node-rs/argon2`), JWT via `jose` em cookies httpOnly (`nexus_at`/`nexus_rt`),
  MFA TOTP (`otplib`+`qrcode`). Guards `requireAuth`/`requireMfa` (`apps/server/src/auth/plugin.ts`).
- **Segurança da Tela:** VNC só em loopback; tudo na rede vai cifrado em **WSS/TLS** (relay atrás do
  Traefik). Padrão a reaproveitar: **túnel reverso outbound + relay + viewer**.
- **mTLS (Inc 2/3):** CA interna (`node-forge`) emite cert por máquina no enrollment; gateway de
  agentes em **porta 8443** dedicada (Node termina TLS + exige cert de cliente — fora do Traefik,
  que descartaria o cert). Painel/admin continuam atrás do Traefik (443).

### ⭐ Fluxo "Acesso não supervisionado à tela" (produção — IMPLEMENTAR ASSIM)
**A única senha que o admin digita é a do PAINEL (login + MFA). Senha de tela: NUNCA.**
1. **Cadastro (1x por PC):** painel gera token → instalador do agente (assinado, "next-next-finish")
   → agente se registra sozinho (mTLS) → máquina aparece ONLINE no painel, sem config manual.
2. **Agente roda como SERVIÇO** (não supervisionado; sobrevive reboot/logoff) e mantém o servidor de
   tela SÓ no loopback do PC (nunca exposto à rede).
3. Admin (já logado c/ senha+MFA) clica **"Acesso não supervisionado"** numa máquina.
4. O servidor, **automaticamente**: (a) autoriza pela sessão do admin (RBAC) + identidade mTLS da
   máquina; (b) **gera credencial EFÊMERA de tela** (uso único, validade curta) e **injeta sozinho** no
   viewer e no agente — o admin **não digita senha de tela**; (c) manda o agente abrir a sessão;
   (d) **registra na auditoria** (quem, qual máquina, quando).
5. Tela abre embutida no painel, cifrada (WSS/TLS), com controle. Ao fechar, a credencial expira.
> No spike havia 2 senhas: a do *relay* (manual) e a do *VNC* (já auto-injetada). Em produção o login
> do relay é substituído pela **sessão do painel**, e a credencial de tela vira **efêmera por clique e
> auto-injetada**. Reaproveitar o transporte do `spike/` (túnel reverso + relay + viewer), trocando a
> autenticação manual por: sessão do painel + grant efêmero emitido pelo servidor.

---

## 4. CONVENÇÕES (git, código, commits)

- **Git:** trabalhar em `main` localmente; commits pequenos. Deploy ao servidor via **git bundle**
  (ver §5) — NUNCA commitar dentro do servidor e do local ao mesmo tempo (gera divergência).
  O canônico é o LOCAL; o servidor recebe.
- **Mensagem de commit:** descritiva em pt-BR, terminando com:
  `Co-Authored-By: Antigravity <noreply@antigravity>` (ou o autor real). NUNCA usar `--no-verify`.
- **Código:** TypeScript strict, `noUncheckedIndexedAccess` (cuidado com `arr[0]` → pode ser undefined).
  Validar entrada com Zod na borda. Logs estruturados com pino (tenantId, machineId, commandId).
- **Skills:** biblioteca completa em `skills/` (gitignored). Consultar a skill do tema antes de
  construir: `drizzle-orm-expert`, `mtls-configuration`, `nextjs-app-router-patterns`,
  `powershell-windows`, `nodejs-backend-patterns`, etc. (ver `CLAUDE.md`).
- **Convenções do produto:** ler e MANTER o `CLAUDE.md` da raiz (norte do produto, princípios
  não-funcionais, técnicas).

---

## 5. FLUXO DE TRABALHO (editar → validar → deploy)

**Editar:** sempre no repo LOCAL.

**Validar local** (se Docker local estiver disponível) ou no servidor:
```
pnpm install
pnpm typecheck && pnpm build && pnpm test
```

**Deploy ao servidor** (preservando os `.env`):
```bash
# no repo local:
git add -A && git commit -m "..."
git bundle create nexus-rmm.bundle --all
scp -i <PEM> nexus-rmm.bundle opc@sis.gmtec.tec.br:/home/opc/SIGU/Sistema_PCs/
# no servidor (preservar .env e spike/.env!):
cd /home/opc/SIGU/Sistema_PCs
cp nexus-rmm/.env /tmp/env.bak; cp nexus-rmm/spike/.env /tmp/spikeenv.bak
rm -rf nexus-rmm.new && git clone -q nexus-rmm.bundle nexus-rmm.new
rm -rf nexus-rmm && mv nexus-rmm.new nexus-rmm
cp /tmp/env.bak nexus-rmm/.env; mkdir -p nexus-rmm/spike; cp /tmp/spikeenv.bak nexus-rmm/spike/.env
cd nexus-rmm && pnpm install && pnpm db:migrate && pnpm typecheck && pnpm test
```
> Alternativa mais simples quando só mudam arquivos de código: `scp` direto dos arquivos alterados
> para o servidor e rodar `pnpm typecheck/test` lá. Depois trazer o `pnpm-lock.yaml` de volta ao local.

**Infra no servidor:** `pnpm infra:up` (Postgres/Redis). Se trocar senha do Postgres, recriar volume:
`docker compose --env-file .env -f infra/docker-compose.yml down -v && pnpm infra:up`.

**Operação no-code:** `./gerenciar.sh` (menu) e Portainer.

---

## 6. PRÓXIMAS TAREFAS (executar nesta ordem; uma de cada vez)

### Inc 2 — CA interna + Enrollment (mTLS)
- `apps/server/src/pki/ca.ts`: gera/carrega CA interna (node-forge) em `secrets/ca.{key,crt}` (gitignored).
- `apps/server/src/pki/issue.ts`: emite cert de cliente (CN = machineId) assinado pela CA.
- `apps/server/src/routes/enroll.ts`: `POST /api/enroll` (valida token em `tokens_enrollment`, cria
  `maquinas`, devolve bundle cert+key+ca); `POST /api/enroll-tokens` (owner gera token, guarda hash).
- **Aceite:** teste que prova enrollment cria máquina + emite cert válido pela CA; typecheck/build verdes.

### Inc 3 — Gateway Socket.io (presença + mTLS)
- `apps/server/src/gateway/index.ts`: servidor HTTPS na **porta 8443** com `requestCert:true,
  rejectUnauthorized:true, ca:<CA>` → namespace `/agent` (mTLS; machineId do CN). Namespace `/admin`
  (JWT do painel, via Traefik/443).
- Eventos do `@nexus/protocol`: `AgentHello`/`AgentHeartbeat` → `maquinas.online=true`, presença no
  Redis com TTL; emitir `MachinePresence` p/ `/admin`.
- **Aceite:** teste que conexão com cert inválido é recusada e válida marca máquina online.

### Inc 4 — 🎯 Painel web (Next.js) — payoff visual
- `apps/web` (`@nexus/web`, Next.js 15 App Router + Tailwind): `/login` (+ MFA), `/mfa/setup` (QR),
  `/` dashboard (máquinas online/offline ao vivo via `/admin` socket; serviços; botão "Cadastrar máquina"
  que gera token e mostra o comando do agente). Reaproveitar o viewer de tela do spike.
- Cliente por `fetch` (cookies) + `socket.io-client`. Next `rewrites` `/api`→server (mesma origem, sem CORS).
- **Aceite:** logar com senha+MFA, ver dashboard, gerar token. `pnpm build` do web verde.

### Inc 5 — Containers + Traefik + no-code
- `apps/server/Dockerfile`, `apps/web/Dockerfile`; adicionar serviços `nexus-server` e `nexus-web` ao
  compose com labels Traefik (**`rmm.gmtec.tec.br`** → web; `/api` → server), publicar 8443 (gateway),
  volume `./secrets`. Atualizar `gerenciar.sh` com opções do painel. Verificar no Portainer.
- **Aceite:** `https://rmm.gmtec.tec.br` abre o painel com cert válido; deploy `docker compose up -d`.

---

## 7. CHECKLIST ANTES DE QUALQUER DEPLOY
- [ ] `pnpm typecheck` verde · [ ] `pnpm build` verde · [ ] `pnpm test` verde
- [ ] `.env`/segredos preservados no servidor (não sobrescritos)
- [ ] Sem segredo novo commitado (conferir `git status` / `.gitignore`)
- [ ] Fase 0 ainda passa (teste de auditoria) · [ ] `/healthz`+`/readyz` = 200
- [ ] Atualizou `PROGRESSO.md` com o que foi feito

## 8. O QUE NUNCA FAZER
- ❌ Commitar `.env`, chaves, `secrets/`, `node_modules/`, `skills/` (já gitignored).
- ❌ Rodar `docker compose down -v` em produção sem confirmar (apaga volumes/dados).
- ❌ Mexer em DNS (Cloudflare), firewall, ou instalar software na máquina do usuário sem OK.
- ❌ Mudar stack/arquitetura/protocolo sem aprovação do usuário.
- ❌ Commitar no servidor E no local ao mesmo tempo (divergência de git).
- ❌ Imprimir senhas/tokens no chat ou em arquivos versionados.
- ❌ Adicionar UPDATE/DELETE na tabela de auditoria.

---

## 9. DNS `rmm.gmtec.tec.br` (ação do usuário no Cloudflare)
O domínio está no Cloudflare. Para o painel responder em `rmm.gmtec.tec.br`:
1. Cloudflare → domínio `gmtec.tec.br` → **DNS** → **Add record**.
2. Type **A** · Name **rmm** · IPv4 **163.176.169.89** · Proxy status **DNS only** (nuvem cinza) · Save.
3. Avisar o Claude/Antigravity. O servidor (Traefik + Let's Encrypt) emite o cert sozinho quando o
   Inc 5 subir o painel com a label `Host(\`rmm.gmtec.tec.br\`)`. Verificar: `nslookup rmm.gmtec.tec.br 8.8.8.8`.

> Enquanto o DNS não existir, o painel pode ser servido temporariamente em
> `https://sis.gmtec.tec.br/painel/` (rota de caminho, como o spike), sem depender do Cloudflare.
