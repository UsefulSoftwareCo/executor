# Self-host Executor

Run Executor in one Docker container. It includes the dashboard, API, MCP server,
PGlite database, and isolated app runtime. You do not need a separate database,
Node, or Bun on the host.

## Run the published beta

The beta image is `ghcr.io/usefulsoftwareco/executor-selfhost:beta`, for Linux
amd64 and arm64. The `latest` tag still belongs to Executor v1. Use a new data
volume for v2; this is not an in-place v1 data migration.

No environment variables are required locally. Executor generates and saves its
session and encryption keys in the persistent volume on first boot.

```sh
docker pull ghcr.io/usefulsoftwareco/executor-selfhost:beta
docker run --detach --name executor-v2 --init --restart unless-stopped \
  --publish 127.0.0.1:4400:4400 \
  --volume executor-v2-data:/app/data \
  ghcr.io/usefulsoftwareco/executor-selfhost:beta
```

Open `http://localhost:4400` and create the first administrator. The container
includes the dashboard, API, MCP server, database, and app runtime. For a pinned
release, use `beta-<full Git commit SHA>` instead of the moving `beta` tag.
Before updating, stop the container and back up its volume. Pull the new image,
remove only the stopped container, and repeat the run command with the same
volume and secrets.

## Build from source

Install Docker with Docker Compose and Git, then get the public v2 source:

```sh
git clone --depth 1 --branch v2 https://github.com/UsefulSoftwareCo/executor.git executor-v2
cd executor-v2
```

For a local installation:

```sh
docker compose -f apps/hosted/self-host/compose.yaml up --build --detach
```

Optional overrides are `BETTER_AUTH_URL` (exact public origin),
`BETTER_AUTH_SECRET` (at least 32 characters), and `EXECUTOR_ENCRYPTION_KEY`
(exactly 64 hexadecimal characters). Explicit keys stay in your secret manager;
the server saves only keys it generates. Keep the original values across upgrades.

Open [http://localhost:4400](http://localhost:4400) and complete the first-admin setup.
Self-host uses password login by default. Add an app, then connect an account from
the app page. For MCP client setup, open **Connect** in the sidebar and follow the
instructions for your client. MCP uses browser sign-in.

The health endpoint is [http://localhost:4400/health](http://localhost:4400/health).

## Railway

Create an image service from `ghcr.io/usefulsoftwareco/executor-selfhost:beta`,
attach a new volume at `/app/data`, and generate a public domain routed to port
`4400` (or your `PORT`). Set the healthcheck path to `/health` with a 120-second
startup timeout. Deploy, open the domain, and create the first administrator.

Executor derives its HTTPS origin from `RAILWAY_PUBLIC_DOMAIN`, generates keys,
and prepares Railway's root-owned mount before dropping to the `node` user.
No secret variables, external database, custom start command, or
`RAILWAY_RUN_UID` override are needed. Use one replica. For a custom domain,
set `BETTER_AUTH_URL` to its exact HTTPS origin. App web pages still require
wildcard DNS as described below.

## Data and updates

The named `pglite-data` volume stores the database, app source, builds, app data,
diagnostics, and generated `auth-secret.key` and `encryption.key` files under `/app/data`. Keep one server instance per data volume.

Before an upgrade, stop the server and back up the whole volume, including the
key files. Keep any explicit secret overrides in your secret manager. An existing
database with a missing or invalid saved key will not start; restore the original
key instead of generating a replacement. To build and start an updated version:

```sh
git pull --ff-only
docker compose -f apps/hosted/self-host/compose.yaml up --build --detach
```

To stop the server while retaining its data:

```sh
docker compose -f apps/hosted/self-host/compose.yaml down
```

## Serve other users

The supplied Compose file binds port 4400 to the host's loopback interface.
For remote access, put an HTTPS reverse proxy in front of it and set
`BETTER_AUTH_URL` to the exact public dashboard origin, such as
`https://executor.example.com`.

Localhost derives app UI addresses automatically. For a public installation,
set `EXECUTOR_APP_UI_BASE_URL` to a separate HTTPS base such as
`https://apps.example.com`. Route that base and its wildcard subdomains to the
same server, with a matching TLS certificate. App addresses take the form
`<app-slug>--<organization-slug>.apps.example.com`.

When the dashboard origin is private, app code can reach private network
addresses by default. Set `EXECUTOR_APPS_ALLOW_PRIVATE_FETCH=false` to block
that access. This also blocks the built-in Executor app from calling a private
dashboard origin.

Optional OIDC SSO and observability settings are listed in [compose.yaml](compose.yaml).

## Diagnose startup

```sh
docker compose -f apps/hosted/self-host/compose.yaml ps
docker compose -f apps/hosted/self-host/compose.yaml logs --tail 100 server
```

The first source build downloads its dependencies. Later builds reuse Docker's
cache. The Compose commands above build from source and do not depend on the
published container image. For the published installation, use
`docker logs --tail 100 executor-v2` and `docker inspect executor-v2` to inspect
startup and health.
