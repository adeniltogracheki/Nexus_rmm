# Nexus RMM — Fase 0 (fundação)

Monorepo **pnpm + TypeScript (ESM)** que entrega a fundação de um RMM multi-tenant:
contrato compartilhado (`@nexus/protocol`), servidor Fastify (`@nexus/server`) com
health checks, schema Postgres multi-tenant via Drizzle e **auditoria imutável com
cadeia de hash** (tamper-evident). **Sem auth/agente/WebSocket ainda** — isso é Fase 1.

## Versões usadas

O brief (§2) pede Node 20 LTS + pnpm 9. Este repo foi construído e validado no
servidor com **Node 22.22 + pnpm 10.26** (últimas estáveis compatíveis), conforme a
§2 autoriza. `engines.node` continua `>=20.11`, então um clone em Node 20 também roda.

| Item | Pedido no brief | Usado aqui |
|---|---|---|
| Node | 20.11+ | 22.22 |
| pnpm | 9.x | 10.26 |
| TypeScript | ^5.6 | ^5.6 (strict) |
| Fastify | ^5 | ^5 |
| Drizzle ORM | ^0.36 | ^0.36 (+ drizzle-kit ^0.28) |
| Postgres / Redis | 16 / 7 | 16 / 7 (Docker) |

## Setup (clone limpo)

```bash
pnpm install
cp .env.example .env          # ajuste as senhas
pnpm infra:up                 # sobe Postgres 16 + Redis 7 (Docker)
pnpm db:generate              # gera as migrations a partir do schema
pnpm db:migrate               # aplica migrations + hardening (RLS + hash + REVOKE)
pnpm dev                      # sobe o servidor em http://localhost:4000
```

Health checks:

```bash
curl -s localhost:4000/healthz   # 200 {"status":"ok",...}
curl -s localhost:4000/readyz    # 200 se Postgres e Redis respondem
```

Qualidade e teste de imutabilidade:

```bash
pnpm typecheck                # TS strict em todos os pacotes
pnpm build                    # compila protocol + server
pnpm test                     # prova a imutabilidade da auditoria (precisa do banco no ar)
```

## Operação sem código (`gerenciar.sh`)

Para o dia a dia **sem mexer em código ou decorar comandos**, rode o menu:

```bash
./gerenciar.sh
```

Aí é só escolher um número: subir/parar banco e cache, ver status, atualizar a
estrutura do banco, ver logs ao vivo, testar a saúde do servidor, fazer backup do
banco ou atualizar o sistema. Os backups ficam em `backups/`.

> A partir da Fase 1, o servidor também roda em container (atrás do Traefik) e
> aparece no **Portainer**, permitindo iniciar/parar/ver logs pela tela do navegador.

## Estrutura

```
packages/protocol   # @nexus/protocol — eventos, comandos (Zod) e DTOs de telemetria
apps/server         # @nexus/server — Fastify, config (Zod), Drizzle, /healthz, /readyz
infra               # docker-compose (postgres:16 + redis:7) + init da role nexus_app
.github/workflows   # CI: install + typecheck + build
```

## Segurança da auditoria (importante)

- A tabela `logs_servicos_windows` é **append-only**. Um trigger `BEFORE INSERT`
  encadeia `hash_registro = sha256(hash_anterior || campos)`, tornando qualquer
  adulteração **detectável** (a verificação recalcula o hash da linha e compara).
- `REVOKE UPDATE, DELETE ... FROM PUBLIC` é aplicado. Na Fase 0 a role `nexus_app`
  cria e portanto **possui** as tabelas, e o dono ignora o REVOKE — por isso a
  **cadeia de hash é a garantia real de tamper-evidence** (conforme o brief §5.2).
  Na Fase 1, separar a role dona (migrations) da role da app (runtime) fecha esse gap.
- **RLS multi-tenant** está habilitado com `FORCE ROW LEVEL SECURITY` e policy
  `USING (tenant_id = current_setting('app.tenant_id', true)::uuid)` nas tabelas com
  `tenant_id`. O scoping primário na Fase 0 é por aplicação; o RLS é defesa em
  profundidade. Cada conexão deve executar `SET app.tenant_id = '<uuid>'`.

## Critérios de aceite (Fase 0)

1. `pnpm install` sem erro.
2. `pnpm infra:up` sobe Postgres 16 + Redis 7.
3. `pnpm db:generate && pnpm db:migrate` cria as tabelas e aplica o hardening.
4. `pnpm dev` → `GET /healthz` = 200 e `GET /readyz` confirma Postgres + Redis.
5. `pnpm typecheck` verde.
6. CI (GitHub Actions) verde: install + typecheck + build.
7. `pnpm test` prova: 2 logs encadeiam o hash; um `UPDATE` direto quebra a verificação.

## Desvios do brief (registrados)

- **Node/pnpm**: 22/10 em vez de 20/9 (autorizado pela §2).
- **`tokens_enrollment`**: a §5 pede a tabela mas ela não estava na árvore da §3;
  foi colocada em `apps/server/src/db/schema/enrollment.ts`.
- **`lint`**: stub (`echo ok`) na Fase 0; ESLint entra junto com a app Next.js (Fase 1+).
