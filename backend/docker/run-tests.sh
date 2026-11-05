#!/usr/bin/env bash
# Runs inside the test image (./cartly test). Each suite gets a fresh database with the demo store and test kit,
# the way CI runs them. Exits non-zero on the first failure, naming the step.
#   ./cartly test            everything
#   ./cartly test api|ai|web only that part
set -uo pipefail
cd /repo
ONLY="${1:-all}"
PASS=()
step() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
run() {
  local name="$1"; shift
  step "$name"
  if "$@"; then PASS+=("$name"); else printf '\n\033[31m✗ %s failed\033[0m\n' "$name"; exit 1; fi
}

PG="postgresql://cartly:cartly@${TEST_DB_HOST:-postgres-test}:5432"
export REDIS_URL="${REDIS_URL:-redis://redis-test:6379/0}"
export JWT_SECRET=test-jwt-secret-not-for-production INTERNAL_API_KEY=test-internal-key \
  PAYMENT_SECRETS_KEY=test-payment-secrets-key-0123456789 API_PORT=4100 AI_PORT=8001 UPLOAD_DIR=/tmp/cartly-uploads
mkdir -p "$UPLOAD_DIR"

# A fresh database: created if missing, then migrated and loaded with the demo store, test kit and cut-outs.
fresh_db() {
  local db="$1"
  (cd backend/api && node -e "
    const { Client } = require('pg');
    (async () => {
      const c = new Client({ connectionString: '$PG/postgres' });
      await c.connect();
      await c.query('DROP DATABASE IF EXISTS $db WITH (FORCE)');
      await c.query('CREATE DATABASE $db');
      await c.end();
    })().catch((e) => { console.error(e.message); process.exit(1); });") &&
  (cd backend/api && DATABASE_URL="$PG/$db" npx prisma migrate deploy >/dev/null && DATABASE_URL="$PG/$db" npx tsx scripts/first-run.ts)
}

if [ "$ONLY" = all ] || [ "$ONLY" = api ]; then
  cd backend/api
  run "API: lint (oxlint)" npm run -s lint
  run "API: types (tsc)" npm run -s typecheck
  run "API: unit tests" npm test --silent
  cd /repo
  run "API: fresh database with the demo store" fresh_db cartly_api_test
  cd backend/api
  run "API: end-to-end tests (real Postgres + Redis)" env DATABASE_URL="$PG/cartly_api_test" NODE_ENV=test npm run -s test:e2e
  cd /repo
fi

if [ "$ONLY" = all ] || [ "$ONLY" = ai ]; then
  run "AI service: fresh database with the demo store" fresh_db cartly_ai_test
  cd backend/ai
  run "AI service: lint (ruff)" ruff check app tests
  run "AI service: tests (pytest)" env DATABASE_URL="$PG/cartly_ai_test" REDIS_URL="${REDIS_URL%/*}/1" python -m pytest -q
  cd /repo
fi

if [ "$ONLY" = all ] || [ "$ONLY" = web ]; then
  for app in storefront admin; do
    cd "/repo/$app"
    run "$app: lint (eslint)" npm run -s lint -- --quiet
    run "$app: production build" env VITE_SHOW_TEST_ACCOUNTS=false npx vite build --outDir /tmp/build-$app --emptyOutDir --logLevel warn
  done
  cd /repo
fi

printf '\n\033[32m✓ All %d checks passed:\033[0m\n' "${#PASS[@]}"
printf '  · %s\n' "${PASS[@]}"
