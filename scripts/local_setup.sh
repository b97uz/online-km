#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[0/9] Preparing env files"
if [ ! -f .env ]; then
  cp .env.example .env
fi
cp .env apps/web/.env.local
cp .env packages/db/.env

set -a
source .env
set +a
export NODE_ENV=development

echo "[1/9] Checking Node.js"
node -v
npm -v

echo "[2/9] Checking pnpm via npx"
npx -y pnpm@9.15.0 -v

echo "[3/9] Installing dependencies"
npx -y pnpm@9.15.0 install --prod=false

echo "[4/9] Generating Prisma client"
npx -y pnpm@9.15.0 db:generate

echo "[5/9] Checking PostgreSQL tools"
if ! command -v createdb >/dev/null 2>&1; then
  echo "createdb not found. Install PostgreSQL first."
  exit 1
fi

echo "[6/9] Checking PostgreSQL server"
if command -v pg_isready >/dev/null 2>&1; then
  if ! pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
    echo "PostgreSQL server is not ready."
    echo "Open Postgres.app, click Initialize, then start server."
    exit 1
  fi
fi

echo "[7/9] Creating DB if missing"
createdb kelajak_mediklari 2>/dev/null || true

echo "[8/9] Running migration"
npx -y pnpm@9.15.0 --filter @km/db exec prisma migrate dev --name init

echo "[9/10] Seeding admin"
npx -y pnpm@9.15.0 db:seed

echo "[10/10] Setting up Python bot (aiogram)"
cd python-aiogram
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
.venv/bin/pip install -r requirements.txt
cd ..

echo ""
echo "Setup completed successfully."
echo "Now run web (terminal 1):  bash scripts/local_run_web.sh"
echo "Then run bot (terminal 2): bash scripts/local_run_bot.sh"
