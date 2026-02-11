#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  cp .env apps/bot/.env
  cp .env packages/db/.env
  set -a
  source .env
  set +a
fi
export NODE_ENV=development
unset BOT_WEBHOOK_URL
unset BOT_WEBHOOK_PATH

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

cd apps/bot
npm exec -- tsx watch src/index.ts
