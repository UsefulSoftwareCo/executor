FROM oven/bun:1.3.11 AS build
WORKDIR /build
COPY package.json bun.lock ./
COPY patches ./patches
COPY tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY playground ./playground
COPY e2e/viewer/package.json ./e2e/viewer/package.json
RUN bun install --frozen-lockfile --filter @executor-js/hosted-self-host --filter @executor-js/hosted-self-host-web --filter @executor-js/telemetry
RUN bun run --cwd packages/telemetry build:motel
RUN bun run --cwd apps/hosted/self-host/web build
RUN bun run --cwd apps/hosted/self-host build
FROM node:24.14.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production EXECUTOR_ENVIRONMENT=self-host HOST=0.0.0.0 PORT=4400 DASHBOARD_DIR=/app/web EXECUTOR_DATA_DIR=/app/data
WORKDIR /app
# Keep workspace packages and the compiler available for app deployment at runtime.
# Native module resolution must find the same Effect tree as the SDK.
COPY --from=build --chown=node:node /build/node_modules ./node_modules
COPY --from=build --chown=node:node /build/packages ./packages
COPY --from=build --chown=node:node /build/apps/hosted/server ./apps/hosted/server
COPY --from=build --chown=node:node /build/apps/hosted/self-host/node_modules ./apps/hosted/self-host/node_modules
COPY --from=build --chown=node:node /build/apps/hosted/self-host/dist ./apps/hosted/self-host/dist
COPY --from=build --chown=node:node /build/apps/hosted/self-host/web/dist ./web
RUN mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data
VOLUME /app/data
USER node
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:" + process.env.PORT + "/health").then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))'
CMD ["node", "apps/hosted/self-host/dist/main.mjs"]
