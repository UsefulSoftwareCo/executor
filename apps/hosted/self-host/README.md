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
release, use a published version such as `2.0.0-beta.N` instead of the moving
`beta` tag. The `beta` tag moves only once a release is public, so it always
exists; a version tag exists once its GitHub release is published.
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
EXECUTOR_BUILD_VERSION="$(git rev-parse HEAD)" docker compose -f apps/hosted/self-host/compose.yaml up --build --detach
```

The build requires `EXECUTOR_BUILD_VERSION`, which names the build in telemetry.
The command above sets it to the checked-out commit.

Optional overrides are `BETTER_AUTH_URL` (exact public origin),
`BETTER_AUTH_SECRET` (at least 32 characters), and `EXECUTOR_ENCRYPTION_KEY`
(exactly 64 hexadecimal characters). Explicit keys stay in your secret manager;
the server saves only keys it generates. Keep the original values across upgrades.

Open [http://localhost:4400](http://localhost:4400) and complete the first-admin setup.
Self-host uses password login by default. Add an app, then connect an account from
the app page. For MCP client setup, open **Connect** in the sidebar and follow the
instructions for your client. MCP uses browser sign-in.

The health endpoint is [http://localhost:4400/health](http://localhost:4400/health).

### Health checks

`/health` answers `200` once the server is ready. The thread that answers it also runs the rest of
the product and commits its storage, syncing each commit to disk before it continues, so on a slow
disk every response, `/health` included, can wait seconds behind one commit. With 30 apps running
schedules on a desktop disk, `/health` took up to 16.5 seconds (99th percentile 12.9 seconds); on a
disk limited to 5 writes a second, up to 34 seconds.

The image's own check allows 30 seconds a probe and marks the container unhealthy after three
failures in a row: a server that stops answering is marked unhealthy within three minutes, and one
that never answers from its first boot after about five. 30 seconds covers every stall measured on
the desktop disk but not the slowest answer on the throttled one, so on a disk that slow a check can
still fail now and then; only three failures in a row count. Give your own probes the same room:

- **Kubernetes.** A probe's `timeoutSeconds` defaults to 1 second, which ordinary commit stalls on a
  slow disk exceed. When a liveness probe fails `failureThreshold` times in a row, the kubelet
  restarts the container; one failed probe does not. Give a readiness probe the liveness probe's
  timeout.

  ```yaml
  startupProbe:
    httpGet: { path: /health, port: 4400 }
    periodSeconds: 10
    timeoutSeconds: 10
    failureThreshold: 18 # about three minutes, whether probes fail at once or time out
  livenessProbe:
    httpGet: { path: /health, port: 4400 }
    periodSeconds: 30
    timeoutSeconds: 30
    failureThreshold: 3
  ```

  Until the server is ready, `/health` answers `503` at once, and one success ends the startup
  probe, so it can wait less than the liveness probe: its 18 attempts take about three minutes
  either way. With these settings a server that stops answering is restarted 90 to 120 seconds
  later, or 60 to 90 seconds once its connections are refused, plus the pod's termination grace
  period.

- **Railway** checks `/health` only while a deployment starts, to decide when to send it traffic,
  and does not probe a running service. Set the path to `/health` and the timeout to 120 seconds.
- **Docker Compose or another supervisor** with its own check: allow 30 seconds a probe and three
  failures, for example `timeout: 30s`, `interval: 30s` and `retries: 3`.

### Runtime packaging

The Docker build produces a standalone server bundle. It prepares the trusted
Worker host and framework once; authored apps still compile inside workerd.
The image retains PGlite, one native workerd binary, the dashboard, a small native host for Git, keys, locks, and HTTP, and the
telemetry collector. Executor, authored apps and workflows share one workerd executable. The
collector is `executor-collector` (`packages/telemetry/collector`), a separate Rust process the
native host supervises on a private Unix socket; it shares the container's CPU, memory and disk with
the product. Its `collector` build stage builds it from the crate with the toolchain the crate pins,
and its notices are under `/usr/share/doc/executor-collector/`. The image does not serve the
trace viewer: the collector has no address a browser can reach. Neither Bun, Node nor Rust ships in
the runtime image. Build tools and the workspace dependency tree stay in the build stages.

The image runs Executor's build of workerd from
[UsefulSoftwareCo/workerd](https://github.com/UsefulSoftwareCo/workerd), pinned by
release and SHA-256 in `workerd.json`; packaging downloads it and fails on any other
digest. It adds idle-isolate and memory-pressure garbage collection and TCMalloc
memory release, set by `memory` in the generated `workerd.capnp`. Cloud and local development keep
upstream workerd.

The runtime uses Debian 12 distroless with Git's native commands and HTTP backend,
their shared libraries, and the small set of tools used to prepare data volumes.
Perl, package managers, Git's optional scripts, and their dependencies stay in a
separate build stage. `/usr/share/runtime-system-packages.txt` records the copied
system package versions; their license notices remain under `/usr/share`.

Effect composes product services inside workerd. The native host forwards public
HTTP to a private Worker socket and compresses text responses with brotli or gzip,
as each client accepts. Event streams stay unencoded, and a reverse proxy in front
sees encoded responses and does not compress them again. Outbound requests use the shared URL policy and
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

The telemetry collector keeps its store in `EXECUTOR_MOTEL_DATA_DIR`, by default `/app/motel-data`; the
name is historical, from Motel, the collector earlier images ran. Container replacement discards
telemetry by default. Mount a separate volume there only if retention is wanted. The collector
neither reads nor removes the `motel/` directory Motel left there (up to about 1 GiB); an image that
runs Motel again finds it as it was. Without a volume there it goes with the old container; with
one, `docker exec <container> rm -rf /app/motel-data/motel` deletes it. See [workerd storage and rollback](../../../notes/self-host-workerd.md)
for the native PostgreSQL import and an export that preserves later product writes.

Before an upgrade, stop the server and back up the whole volume, including the
key files. Keep any explicit secret overrides in your secret manager. An existing
database with a missing or invalid saved key will not start; restore the original
key instead of generating a replacement. To build and start an updated version:

```sh
git pull --ff-only
EXECUTOR_BUILD_VERSION="$(git rev-parse HEAD)" docker compose -f apps/hosted/self-host/compose.yaml up --build --detach
```

To stop the server while retaining its data:

```sh
docker compose -f apps/hosted/self-host/compose.yaml down
```

## App catalog

Onboarding and **Add app** list Executor's official apps from the published
feed at `https://catalog.executor.sh/index.json`. The server reads the feed's
index whenever the catalog is listed, which is more often than those two pages
open: each dashboard page load lists it once to show app icons, and each catalog
query from an agent lists it again. Reads that overlap share one request. When
the feed sends an `ETag`, as the published feed does, the server asks whether
the index changed since its last read and downloads it again only when it has;
a feed that sends no `ETag` is downloaded and decoded on every read, and so is
the first read after the server restarts. Adding an app fetches that app's source, and the
browser loads app icons from the same host.

To read another copy of the feed, set `EXECUTOR_CATALOG_URL` to its
`index.json`. On an instance without outbound internet access, set
`EXECUTOR_CATALOG_URL=off`: onboarding and Add app then say the catalog is off
and list only the built-in Executor app, and you can still add apps by URL or
build your own. When the feed cannot be reached or read, both pages say so with
a retry, and the built-in Executor app stays listed. An agent's catalog query
fails with the same explanation, as it failed before.

## Serve other users

The supplied Compose file binds port 4400 to the host's loopback interface.
For remote access, put an HTTPS reverse proxy in front of it and set
`BETTER_AUTH_URL` to the exact public dashboard origin, such as
`https://executor.example.com`.

### Rate limits behind a proxy

Sign-in and the other auth routes are rate-limited per client address. Behind a
proxy every connection comes from the proxy, so by default all users share one
limit, and three failed sign-ins from one person lock everyone out for about
ten seconds. Set `EXECUTOR_TRUSTED_PROXIES` to the addresses your proxies
connect to the container from, separated by commas. The Docker image and the
Compose build read it; running `src/main.ts` from source, as `bun run hosted:dev`
does, does not.

A request from a listed address takes its client from `X-Forwarded-For`, read
from the right past every listed address. Each proxy must append the address it
received the request from, as Caddy, Traefik, Cloudflare and nginx's
`$proxy_add_x_forwarded_for` do. When every listed address is such a proxy and
no client can connect from one, the entry used was written by your proxy, so
what a client puts in the header itself is never used. Requests from any other
address use the connection's address, and with the setting empty nothing
changes. Startup fails on an entry that is neither an address nor a CIDR range.

List each proxy's exact address. A CIDR range is safe only when it holds your
proxies and nothing else. Any machine or container that connects from a listed
address can put any address in `X-Forwarded-For`, directly or through your proxy,
and is limited, and recorded in sessions and audit records, under that address.
So do not list a Docker network's subnet that other containers share, and never
list `0.0.0.0/0` or `::/0`, which trusts every client.

- A proxy on the host, such as Caddy or nginx forwarding to `127.0.0.1:4400`,
  connects from the gateway of the container's Docker network. Find it with
  `docker inspect <container> --format '{{range .NetworkSettings.Networks}}{{.Gateway}} {{end}}'`;
  under Compose, use `$(docker compose -f apps/hosted/self-host/compose.yaml ps -q server)`
  as the container. It is often `172.17.0.1` for `docker run`, and a different
  address for each Compose network. Publishing the port on loopback, as the
  supplied command and Compose file do, keeps remote clients off it, but every
  process on the host reaches the container from that same gateway address.
  Listing the gateway trusts all of them, so do it only on a host where the
  people who can run processes are ones you trust.
- A proxy in another container on the same Docker network connects from that
  container's address. Give the proxy a fixed address and list only that, or
  put it and Executor on a network of their own.
- Cloudflare Tunnel: list the address `cloudflared` connects from, by the same
  rules. Cloudflare appends each visitor's address to `X-Forwarded-For` and
  `cloudflared` passes it on, so no other setting is needed.

Localhost derives app UI addresses automatically. For a public installation,
set `EXECUTOR_APP_UI_BASE_URL` to a separate HTTPS base such as
`https://apps.example.com`. Route that base and its wildcard subdomains to the
same server, with a matching TLS certificate. App addresses take the form
`<app-slug>--<organization-slug>.apps.example.com`.

App code can reach only public addresses. Requests to the dashboard origin go
straight to the server, so the built-in Executor app works when that origin
resolves to a private address. Set `EXECUTOR_APPS_ALLOW_PRIVATE_FETCH=true` to
let app code reach other private network addresses.

Host-side MCP import and OAuth requests have a separate exact-origin allowlist.
Set `EXECUTOR_URL_ALLOW_HTTP_ORIGINS` to a JSON array of HTTP or HTTPS origins,
for example `'["https://mcp.example.com"]'`, to reach that origin when it resolves
to a private address. Entries include the scheme, hostname and optional port,
with no path or trailing slash. Other origins remain subject to the default
network restrictions. Allowlist each origin used by the MCP server's OAuth
metadata and endpoints separately. For an internal CA, set `NODE_EXTRA_CA_CERTS`
to a PEM CA bundle mounted in the container; TLS verification still applies.

Upgrades apply pending data steps at startup, before serving, and log a summary
line starting `Data step pass finished`. Set `EXECUTOR_DATA_STEPS=report` to hold
them: each start then logs what they would change and writes nothing.

Optional OIDC SSO and observability settings are listed in [compose.yaml](compose.yaml).

## Diagnose startup

```sh
docker compose -f apps/hosted/self-host/compose.yaml ps
docker compose -f apps/hosted/self-host/compose.yaml logs --tail 100 server
```

The server opens its database as soon as it starts and logs
`Executor is still starting` every 15 seconds until it can serve requests, then
`Executor is ready at <BETTER_AUTH_URL>`. Until then every request, including
`/health`, gets an immediate `503` with `Executor is starting`. The first boot creates the database,
which can take a minute or more on slower hardware. The image's health check
allows two minutes for that before failures count.

The first source build downloads its dependencies. Later builds reuse Docker's
cache. The Compose commands above build from source and do not depend on the
published container image. For the published installation, use
`docker logs --tail 100 executor-v2` and `docker inspect executor-v2` to inspect
startup and health.
