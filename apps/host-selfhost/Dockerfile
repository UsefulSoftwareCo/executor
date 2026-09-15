# Self-hosted Executor, single container, no external services.
# Build context is the repo root because Bun workspaces need every member:
#   docker build -f apps/host-selfhost/Dockerfile -t executor-selfhost .
#
# Runtime needs this container plus a volume for the data dir:
#   docker run -p 4788:4788 -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
#     -e EXECUTOR_BOOTSTRAP_ADMIN_EMAIL=you@example.com \
#     -e EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD=... \
#     -e EXECUTOR_WEB_BASE_URL=https://your.domain \
#     -v executor-data:/data executor-selfhost

FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 AS prod-deps
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --production --ignore-scripts --filter @executor-js/host-selfhost \
  && bun run apps/host-selfhost/scripts/package-runtime.ts \
  && mkdir -p /runtime-data

FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN cd apps/host-selfhost && bun run build

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f AS runtime
WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/UsefulSoftwareCo/executor" \
      org.opencontainers.image.description="Single-container self-hosted Executor" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    EXECUTOR_HOST=0.0.0.0 \
    PORT=4788 \
    EXECUTOR_DATA_DIR=/data
COPY --from=prod-deps /usr/local/bin/bun /usr/local/bin/bun
COPY --from=prod-deps /app/.selfhost-runtime /app
COPY --from=build /app/apps/host-selfhost/dist /app/apps/host-selfhost/dist
WORKDIR /app/apps/host-selfhost
COPY --from=prod-deps --chown=65532:65532 /runtime-data /data
USER 65532:65532
VOLUME ["/data"]
EXPOSE 4788
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:4788/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["bun", "run", "dist-server/serve.js"]
