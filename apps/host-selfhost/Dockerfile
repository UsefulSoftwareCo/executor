# Self-hosted Executor — single container, no external services.
# Build context is the REPO ROOT (the bun workspace install needs every member):
#   docker build -f apps/host-selfhost/Dockerfile -t executor-selfhost .
#
# Runtime needs nothing but this container + a volume for the data dir:
#   docker run -p 4788:4788 -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
#     -e EXECUTOR_BOOTSTRAP_ADMIN_EMAIL=you@example.com \
#     -e EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD=... \
#     -e EXECUTOR_WEB_BASE_URL=https://your.domain \
#     -v executor-data:/data executor-selfhost
#
# SQLite (libSQL, file:/data/...) lives in /data, QuickJS + MCP run in-process —
# so unlike windmill there's no postgres/worker/proxy to orchestrate.

# ── Build stage: install the workspace + build the SPA ──────────────────────
FROM oven/bun:1 AS build
WORKDIR /app
COPY . .
# Full install (dev deps included — vite/turbo/plugins are needed to build).
RUN bun install --frozen-lockfile
# Builds @executor-js/vite-plugin (via turbo) then the self-host SPA into
# apps/host-selfhost/dist.
RUN cd apps/host-selfhost && bun run build

# ── Runtime stage: serve the built app under Bun ────────────────────────────
FROM oven/bun:1 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    EXECUTOR_HOST=0.0.0.0 \
    PORT=4788 \
    EXECUTOR_DATA_DIR=/data
COPY --from=build /app /app
WORKDIR /app/apps/host-selfhost
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 4788
# serve.ts binds the Effect AppLayer (API + /mcp + /api/auth + /docs) and serves
# the built SPA from ./dist — one process.
CMD ["bun", "run", "src/serve.ts"]
