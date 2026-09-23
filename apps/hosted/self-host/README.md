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

### Runtime packaging

The Docker build produces a standalone server bundle. It prepares the trusted
Worker host and framework once; authored apps still compile inside workerd.
The image retains PGlite, one native workerd binary, the dashboard, and a small native host for Git, keys, locks, and HTTP. Executor,
authored apps, workflows, and Motel share one workerd executable. Neither Bun nor
Node ships in the runtime image. Build tools
and the workspace dependency tree stay in the build stage.

The runtime uses Debian 12 distroless with Git's native commands and HTTP backend,
their shared libraries, and the small set of tools used to prepare data volumes.
Perl, package managers, Git's optional scripts, and their dependencies stay in a
separate build stage. `/usr/share/runtime-system-packages.txt` records the copied
system package versions; their license notices remain under `/usr/share`.

Effect composes product services inside workerd. The native host forwards public
HTTP to a private Worker socket. Outbound requests use the shared URL policy and
workerd's network services, which check resolved destinations before connecting.
HTTP Host and TLS server names are retained. Protocol adapters check each redirect.

`/app/runtime-packages.txt` lists bundled and external dependencies. License
notices and server source maps ship with the image. `/app/runtime-size.json`
reports each component's uncompressed bytes. Packaging fails above a 600 MiB
runtime payload or if an asset link escapes the package. This payload budget
excludes system layers; it is not the compressed download size. Image layer measurements also include the system files and native host.

The **Executor releases** workflow can verify a branch with its `channel`
input set to `build`. Publishing requires an explicit release dispatch.
Both native architectures must pass the Docker release scenarios before the
workflow updates a channel tag. See the [release check](../../../e2e/README.md#targets-and-shared-behavior).

## Railway

Create an image service from `ghcr.io/usefulsoftwareco/executor-selfhost:beta`,
attach a new volume at `/app/data`, and generate a public domain routed to port
`8080` (Railway injects `PORT=8080`; use your own value if you override it).
Set the healthcheck path to `/health` with a 120-second startup timeout.
Deploy, or redeploy if the service already started, so it picks up the new
public domain. Open the domain and create the first administrator.

Executor derives its HTTPS origin from `RAILWAY_PUBLIC_DOMAIN`, generates keys,
and prepares Railway's root-owned mount before dropping to the `executor` user.
No secret variables, external database, custom start command, or
`RAILWAY_RUN_UID` override are needed. Use one replica. For a custom domain,
set `BETTER_AUTH_URL` to its exact HTTPS origin. App web pages still require
wildcard DNS as described below.

## Data and updates

The named `pglite-data` volume stores the database, app source, builds, app data,
and generated `auth-secret.key` and `encryption.key` files under `/app/data`. Keep one server instance per data volume.

Motel uses a separate store at `/app/motel-data`. Container replacement discards
telemetry by default. Mount a separate volume there only if retention is wanted.
Product upgrades do not import old Motel data. See [workerd storage and rollback](../../../notes/self-host-workerd.md)
for the native PostgreSQL import and an export that preserves later product writes.

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
