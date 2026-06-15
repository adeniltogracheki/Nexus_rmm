FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY apps/web ./apps/web

# Instala dependências
RUN pnpm install --frozen-lockfile

# Compila o protocolo e efetua o build de produção do Next.js
RUN pnpm --filter @nexus/protocol build
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @nexus/web build

FROM base AS runner
WORKDIR /app

# Copia a workspace inteira com a build do Next.js e node_modules
COPY --from=builder /app /app

EXPOSE 3000

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

CMD ["pnpm", "--filter", "@nexus/web", "start"]
