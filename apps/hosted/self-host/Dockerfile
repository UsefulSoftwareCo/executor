FROM node:24.22.1-bookworm-slim AS build
# Bun by digest as well as version, so what the tag names cannot change under the build. When the
# version changes, take the index digest that `docker buildx imagetools inspect oven/bun:<version>`
# prints on its first Digest line, and change both together.
COPY --from=oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d /usr/local/bin/bun /usr/local/bin/bun
ARG EXECUTOR_BUILD_VERSION
RUN test -n "$EXECUTOR_BUILD_VERSION" || { echo "EXECUTOR_BUILD_VERSION is required. Pass --build-arg EXECUTOR_BUILD_VERSION=<version>, or set it in the environment for docker compose build." >&2; exit 1; }
ENV EXECUTOR_BUILD_VERSION=$EXECUTOR_BUILD_VERSION EXECUTOR_ENVIRONMENT=self-host
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY package.json bun.lock ./
COPY .gitignore ./
COPY patches ./patches
COPY tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY playground ./playground
COPY e2e/viewer/package.json ./e2e/viewer/package.json
RUN bun install --frozen-lockfile --filter @executor-js/hosted-self-host --filter @executor-js/hosted-self-host-web --filter @executor-js/telemetry --filter apps --filter @executor-js/app-live-inbox
RUN bun run --cwd apps/hosted/self-host/web build
RUN bun run --cwd packages/apps build
RUN bun run --cwd apps/hosted/self-host package:runtime

# The telemetry collector, built from its crate by the same script and toolchain as every release
# target (packages/telemetry/collector/README.md, Release builds). Only the crate, its toolchain
# file and the build script are copied in, so a change elsewhere reuses these layers.
FROM node:24.22.1-bookworm-slim AS collector
ARG TARGETARCH
# gcc compiles the bundled SQLite and links; its binutils give the platform checks objdump. git
# lists the crate's files for the build's identity (an empty repository lists them as untracked).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gcc libc6-dev git && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo PATH=/opt/rust/cargo/bin:$PATH
# rustup-init by version and SHA-256: the pin in .github/actions/rustup/action.yml. Change both
# together. The toolchain itself comes from the crate's rust-toolchain.toml.
RUN set -eu; \
  case "$TARGETARCH" in \
    amd64) triple=x86_64-unknown-linux-gnu; sha=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55 ;; \
    arm64) triple=aarch64-unknown-linux-gnu; sha=9f608c142e0e38a78957d0661ba1dfaf0b6fb37184cfaa4b9a0aa57af6184282 ;; \
    *) echo "No pinned rustup-init for $TARGETARCH." >&2; exit 1 ;; \
  esac; \
  curl --proto '=https' --tlsv1.2 -sSfL -o /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/1.29.3/$triple/rustup-init"; \
  echo "$sha  /tmp/rustup-init" | sha256sum -c -; \
  chmod +x /tmp/rustup-init; \
  /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain none; \
  rm /tmp/rustup-init; \
  rustup set auto-self-update disable
WORKDIR /build/packages/telemetry/collector
COPY packages/telemetry/collector/rust-toolchain.toml ./
RUN rustup toolchain install
COPY packages/telemetry/collector/Cargo.toml packages/telemetry/collector/Cargo.lock ./
# Its own step, so an outage at crates.io is named as one.
RUN cargo fetch --locked
COPY packages/telemetry/collector ./
COPY packages/telemetry/scripts/build-collector.ts /build/packages/telemetry/scripts/
WORKDIR /build
RUN git init --quiet && node packages/telemetry/scripts/build-collector.ts build check

FROM golang:1.27.2-bookworm AS native
WORKDIR /build
COPY apps/hosted/self-host/native/go.mod apps/hosted/self-host/native/go.sum ./
RUN go mod download
COPY apps/hosted/self-host/native ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /executor-host .
# Retain the notices of the Go modules compiled into the host.
RUN go list -deps -f '{{with .Module}}{{if not .Main}}{{.Path}} {{.Dir}}{{end}}{{end}}' . | sort -u | while read -r module directory; do mkdir -p "/licenses/$module" && cp "$directory"/LICENSE* "/licenses/$module/"; done

FROM debian:bookworm-slim AS system
RUN apt-get update && apt-get install -y --no-install-recommends git gosu && rm -rf /var/lib/apt/lists/*
COPY apps/hosted/self-host/scripts/package-system.sh /package-system.sh
RUN sh /package-system.sh

FROM gcr.io/distroless/cc-debian12:latest
ARG EXECUTOR_BUILD_VERSION
# Release builds pass the PostHog ingestion key and host; without both the image sends no analytics.
ARG EXECUTOR_POSTHOG_PUBLIC_KEY=""
ARG EXECUTOR_POSTHOG_HOST=""
ENV EXECUTOR_BUILD_VERSION=$EXECUTOR_BUILD_VERSION EXECUTOR_POSTHOG_PUBLIC_KEY=$EXECUTOR_POSTHOG_PUBLIC_KEY EXECUTOR_POSTHOG_HOST=$EXECUTOR_POSTHOG_HOST
COPY --from=system /runtime/ /
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt NODE_ENV=production EXECUTOR_ENVIRONMENT=self-host HOST=0.0.0.0 PORT=4400 EXECUTOR_DATA_DIR=/app/data EXECUTOR_MOTEL_DATA_DIR=/app/motel-data
WORKDIR /app
COPY --from=build --chown=1000:1000 /build/apps/hosted/self-host/dist/workerd ./
COPY --from=native /executor-host /usr/local/bin/executor-host
COPY --from=native /usr/local/go/LICENSE /usr/share/doc/golang/LICENSE
COPY --from=native /licenses/ /usr/share/doc/executor-host/
COPY --from=collector /build/packages/telemetry/dist/collector/executor-collector ./executor-collector
COPY --from=collector /build/packages/telemetry/dist/collector/NOTICE /build/packages/telemetry/dist/collector/cargo-packages.txt /usr/share/doc/executor-collector/
COPY --from=collector /build/packages/telemetry/dist/collector/licenses/ /usr/share/doc/executor-collector/licenses/
VOLUME /app/data
COPY --chmod=755 apps/hosted/self-host/entrypoint.sh /usr/local/bin/executor-entrypoint
ENTRYPOINT ["executor-entrypoint"]
EXPOSE 4400
# Every response, /health included, waits while the product commits its storage, and on a slow disk
# one commit holds it for seconds (README, Health checks). 30 seconds covers the stalls measured on a
# desktop disk. A server whose requests start to hang is marked unhealthy after three failed checks,
# 147 to 177 seconds later, up from 72 to 102; one that never answers from boot, after about 5 minutes.
HEALTHCHECK --interval=30s --timeout=30s --start-period=120s --retries=3 CMD ["executor-host", "health"]
CMD ["executor-host", "serve"]
