# Every automated check in one image: the API (lint, types, unit, end-to-end), the AI service (ruff, pytest)
# and both web apps (lint, build). Built from the repository root by `./cartly test`; it runs against its
# own throwaway Postgres and Redis (the `test` profile in docker-compose.yml), never the demo store.
FROM node:24-slim AS node

FROM python:3.12-slim
# Node 24 and npm from the official image, so one container runs both stacks.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 NPM_CONFIG_UPDATE_NOTIFIER=false CI=true
WORKDIR /repo

# Dependencies first, so code changes don't reinstall them.
COPY backend/ai/requirements.txt backend/ai/
RUN pip install --no-cache-dir -r backend/ai/requirements.txt ruff
COPY backend/api/package*.json backend/api/prisma.config.ts backend/api/
COPY backend/api/prisma backend/api/prisma
# `npm ci` runs `prisma generate`, which needs a URL but no database.
RUN cd backend/api && DATABASE_URL=postgresql://build@localhost:5432/build npm ci
COPY storefront/package*.json storefront/
RUN cd storefront && npm ci
COPY admin/package*.json admin/
RUN cd admin && npm ci

COPY . .
RUN cd backend/api && DATABASE_URL=postgresql://build@localhost:5432/build npx prisma generate
ENTRYPOINT ["bash", "backend/docker/run-tests.sh"]
