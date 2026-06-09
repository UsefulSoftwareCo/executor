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
# so there's no postgres/worker/proxy to orchestrate.

# ── Build stage: install the workspace + build the SPA ──────────────────────
FROM oven/bun:1 AS build
WORKDIR /app
COPY . .
# Full install (dev deps included — vite/turbo/plugins are needed to build).
RUN bun install --frozen-lockfile
# Builds @executor-js/vite-plugin (via turbo) then the self-host SPA into
# apps/host-selfhost/dist.
RUN cd apps/host-selfhost && bun run build
# Reinstall PRODUCTION deps only, so the runtime image excludes the build/dev
# toolchain pulled by the full workspace install — vite, turbo, wrangler →
# miniflare → sharp/libvips (~800MB), astro, vitest, etc. The built SPA lives in
# apps/host-selfhost/dist (outside node_modules), so it survives the reinstall.
# --ignore-scripts: the root `prepare` hook runs a dev-only tool
# (effect-language-service); runtime deps are prebuilt JS with no postinstall.
RUN rm -rf node_modules && bun install --frozen-lockfile --production --ignore-scripts

# ── Runtime stage: serve the built app under Bun ────────────────────────────
FROM oven/bun:1 AS runtime
WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/RhysSullivan/executor" \
      org.opencontainers.image.description="Single-container self-hosted Executor" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    EXECUTOR_HOST=0.0.0.0 \
    PORT=4788 \
    EXECUTOR_DATA_DIR=/data
COPY --from=build /app /app
WORKDIR /app/apps/host-selfhost
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 4788
# Readiness probe against the public /api/health endpoint (a trivial DB ping).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD bun -e "fetch('http://127.0.0.1:4788/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# serve.ts binds the Effect AppLayer (API + /mcp + /api/auth + /docs) and serves
# the built SPA from ./dist — one process.
CMD ["bun", "run", "src/serve.ts"]
