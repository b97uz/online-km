#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -ti :3000 || true)"
  if [ -n "${PIDS}" ]; then
    kill -9 ${PIDS} || true
  fi
fi

rm -rf apps/web/.next

if [ -f .env ]; then
  cp .env apps/web/.env.local
  cp .env packages/db/.env
  set -a
  source .env
  set +a
fi
export NODE_ENV=development

PG_ISREADY_BIN=""
if command -v pg_isready >/dev/null 2>&1; then
  PG_ISREADY_BIN="pg_isready"
elif [ -x "/Applications/Postgres.app/Contents/Versions/latest/bin/pg_isready" ]; then
  PG_ISREADY_BIN="/Applications/Postgres.app/Contents/Versions/latest/bin/pg_isready"
fi

if [ -n "$PG_ISREADY_BIN" ]; then
  if ! "$PG_ISREADY_BIN" -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
    echo "PostgreSQL ishlamayapti (127.0.0.1:5432). Avval Postgres.app da serverni START qiling."
    exit 1
  fi
fi

cd apps/web
npm exec -- next dev -p 3000
