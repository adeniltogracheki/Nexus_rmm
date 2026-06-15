#!/bin/bash
# Cria a role de aplicação `nexus_app` (não-superusuário) na primeira subida do
# volume do Postgres. Idempotente. A senha vem de NEXUS_APP_PASSWORD (env do container).
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_app') THEN
      CREATE ROLE nexus_app LOGIN PASSWORD '${NEXUS_APP_PASSWORD}';
    END IF;
  END
  \$\$;

  GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO nexus_app;
  -- Fase 0: nexus_app roda as migrations e portanto possui as tabelas.
  -- (Na Fase 1, separar a role dona da role de runtime — ver README.)
  GRANT USAGE, CREATE ON SCHEMA public TO nexus_app;
  -- CREATE no banco: o migrator do Drizzle cria o schema "drizzle" de controle.
  GRANT CREATE ON DATABASE ${POSTGRES_DB} TO nexus_app;

  -- Extensões precisam de superusuário: criadas aqui (postgres), não no hardening.
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";
EOSQL
