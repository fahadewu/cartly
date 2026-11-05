# The commerce API. Build from the backend/ folder:  docker build -f api/Dockerfile .
# (docker compose in the workspace does this for you.)
FROM node:24-slim AS build
WORKDIR /app/api
# Prisma's engines need OpenSSL; slim images don't ship it.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
# `npm ci` runs `prisma generate` (postinstall), so the schema goes in first. Generating needs no database.
ENV DATABASE_URL=postgresql://build@localhost:5432/build
COPY api/package*.json api/prisma.config.ts ./
COPY api/prisma ./prisma
RUN npm ci
COPY api/ ./
RUN npx prisma generate && npx nest build

FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
# Dev dependencies stay in: migrations (prisma), the seed and first-run scripts (tsx) run in this image.
ENV NODE_ENV=production CATALOG_PATH=/app/catalog/catalog.json UPLOAD_DIR=/data/uploads
WORKDIR /app/api
COPY --from=build /app/api ./
COPY catalog/ /app/catalog/
COPY docker/ /app/docker/
EXPOSE 4100
HEALTHCHECK --interval=10s --timeout=5s --start-period=120s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4100)+'/api/v1/health').then(r=>r.json()).then(h=>process.exit(h.status==='ok'?0:1),()=>process.exit(1))"
ENTRYPOINT ["sh", "/app/docker/api-entrypoint.sh"]
