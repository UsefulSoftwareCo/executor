# Vercel container build for the self-hosted app. Vercel containers have no
# persistent filesystem or process affinity, so this image selects remote
# libSQL storage and request-isolated MCP behavior through environment config.

FROM oven/bun:1 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run apps/host-selfhost/scripts/package-runtime.ts \
  && cd apps/host-selfhost \
  && bun run build

FROM gcr.io/distroless/cc-debian12 AS runtime
WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/UsefulSoftwareCo/executor" \
      org.opencontainers.image.description="Vercel deployment of self-hosted Executor" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    EXECUTOR_HOST=0.0.0.0 \
    PORT=80 \
    EXECUTOR_DATA_DIR=/tmp/executor \
    EXECUTOR_MCP_MODE=stateless \
    EXECUTOR_REQUIRE_MANAGED_SECRETS=true
COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
COPY --from=build /app/.selfhost-runtime /app
COPY --from=build /app/apps/host-selfhost/dist /app/apps/host-selfhost/dist
WORKDIR /app/apps/host-selfhost
EXPOSE 80
CMD ["bun", "run", "dist-server/serve.js"]
