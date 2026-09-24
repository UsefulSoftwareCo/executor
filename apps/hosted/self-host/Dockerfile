FROM node:24.18.0-bookworm-slim AS build
COPY --from=oven/bun:1.4.2 /usr/local/bin/bun /usr/local/bin/bun
ARG EXECUTOR_BUILD_VERSION
RUN test -n "$EXECUTOR_BUILD_VERSION"
ENV EXECUTOR_BUILD_VERSION=$EXECUTOR_BUILD_VERSION EXECUTOR_ENVIRONMENT=self-host
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY package.json bun.lock ./
COPY patches ./patches
COPY tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY playground ./playground
COPY e2e/viewer/package.json ./e2e/viewer/package.json
RUN bun install --frozen-lockfile --filter @executor-js/hosted-self-host --filter @executor-js/hosted-self-host-web --filter @executor-js/telemetry --filter apps --filter @executor-js/app-live-inbox
RUN bun run --cwd packages/telemetry build:motel --workerd
RUN bun run --cwd apps/hosted/self-host/web build
RUN bun run --cwd packages/apps build
RUN bun run --cwd apps/hosted/self-host package:runtime

FROM golang:1.26.4-bookworm AS native
WORKDIR /build
COPY apps/hosted/self-host/native ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /executor-host .

FROM debian:bookworm-slim AS system
RUN apt-get update && apt-get install -y --no-install-recommends git gosu && rm -rf /var/lib/apt/lists/*
COPY apps/hosted/self-host/scripts/package-system.sh /package-system.sh
RUN sh /package-system.sh

FROM gcr.io/distroless/cc-debian12:latest
ARG EXECUTOR_BUILD_VERSION
ENV EXECUTOR_BUILD_VERSION=$EXECUTOR_BUILD_VERSION
COPY --from=system /runtime/ /
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt NODE_ENV=production EXECUTOR_ENVIRONMENT=self-host HOST=0.0.0.0 PORT=4400 EXECUTOR_DATA_DIR=/app/data EXECUTOR_MOTEL_DATA_DIR=/app/motel-data
WORKDIR /app
COPY --from=build --chown=1000:1000 /build/apps/hosted/self-host/dist/workerd ./
COPY --from=native /executor-host /usr/local/bin/executor-host
COPY --from=native /usr/local/go/LICENSE /usr/share/doc/golang/LICENSE
VOLUME /app/data
COPY --chmod=755 apps/hosted/self-host/entrypoint.sh /usr/local/bin/executor-entrypoint
ENTRYPOINT ["executor-entrypoint"]
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["executor-host", "health"]
CMD ["executor-host", "serve"]
