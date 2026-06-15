FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY apps/server ./apps/server

# Instala todas as dependências (incluindo devDependencies) para compilação e tsx
RUN pnpm install --frozen-lockfile

# Compila o protocolo
RUN pnpm --filter @nexus/protocol build

# Stage final
FROM base AS runner
WORKDIR /app

# Copia toda a workspace do builder para execução via tsx em produção
COPY --from=builder /app /app

EXPOSE 4000
EXPOSE 8443

ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@nexus/server", "exec", "tsx", "src/index.ts"]
