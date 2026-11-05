#!/bin/sh
# The API container's start: secrets, database upgrades, first-run setup, then the server.
set -e
SECRETS_CREATE=1
. /app/docker/secrets.sh
cd /app/api

# Every start applies any database migrations this version brings (safe when there are none).
echo "Checking the database schema…"
npx prisma migrate deploy

# A fresh database gets the demo store (and, outside production, the test accounts and sandbox
# gateways). Runs once per database: see scripts/first-run.ts.
npx tsx scripts/first-run.ts

exec node dist/main.js
