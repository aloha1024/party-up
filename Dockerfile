# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Maintenance tools are installed from a separate lockfile. They must work
# without network access when migrating, initializing admins, or restoring data.
FROM base AS maintenance
COPY docker/maintenance/package.json docker/maintenance/package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && node node_modules/prisma/build/index.js generate

FROM base AS build
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
COPY . .
ARG APP_VERSION=development
ARG APP_BUILD_DATE
ENV DATABASE_URL=file:/app/data/reservations.db
RUN npm run build && mkdir -p public \
    && APP_VERSION="$APP_VERSION" APP_BUILD_DATE="$APP_BUILD_DATE" node scripts/build-info.mjs --write

FROM base AS runtime
ARG APP_VERSION=development
ARG APP_BUILD_DATE
LABEL org.opencontainers.image.source="https://github.com/aloha1024/party-up" \
      org.opencontainers.image.revision="$APP_VERSION" \
      org.opencontainers.image.created="$APP_BUILD_DATE"
ENV APP_VERSION=$APP_VERSION \
    NODE_ENV=production \
    DATABASE_URL=file:/app/data/reservations.db \
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# Overlay the complete maintenance dependency tree, including the generated
# Linux Prisma client, onto Next's traced server dependencies.
COPY --from=maintenance --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json /app/build-info.json ./
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/scripts ./scripts
RUN mkdir -p /app/data && chown node:node /app/data \
    && sed -i 's/\r$//' /app/scripts/docker-entrypoint.sh \
    && chmod +x /app/scripts/docker-entrypoint.sh
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
