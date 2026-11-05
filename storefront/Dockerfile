# The storefront as static files behind nginx, which also forwards /api to the commerce API.
# docker compose in the workspace builds and runs it; on its own:
#   docker build -t cartly-storefront . && docker run -p 5173:80 -e API_UPSTREAM=http://host.docker.internal:4100 cartly-storefront
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# Baked into the build. VITE_SHOW_TEST_ACCOUNTS=true shows the test logins (the demo); a real store leaves it off.
ARG VITE_API_URL=/api/v1
# Opt-in: only "true" (or "development") shows the test logins; a plain build never does.
ARG VITE_SHOW_TEST_ACCOUNTS=false
ENV VITE_API_URL=$VITE_API_URL VITE_SHOW_TEST_ACCOUNTS=$VITE_SHOW_TEST_ACCOUNTS
RUN npm run build

FROM nginx:1.29-alpine
ENV API_UPSTREAM=http://api:4100
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -q --spider http://127.0.0.1/ || exit 1
