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

Before starting or replacing a source-built host, verify that its advertised SDK
is available from the app builder's registry. Install the checkout's pinned Node
and Bun, then run this gate from the repository root:

```sh
bun install --frozen-lockfile
bun run apps:build
EXECUTOR_NPM_REGISTRY=https://registry.npmjs.org node scripts/releases/apps-self-host.ts
```

Set `EXECUTOR_NPM_REGISTRY` to the **same URL the deployed builder uses**.
Run the gate where that URL resolves, for example inside the Docker network for
a private registry. The builder must have anonymous read access. The gate checks
the staged version against the host version, `runtime.json` and the framework
reference. It downloads the listed tarball, verifies registry integrity and
compares every packaged file with this build. Missing versions, unavailable
archives and different content stop deployment. It never publishes by default.
Do not continue after a failed gate. A healthy `/health` is not an SDK gate.

After the gate passes, start the local installation:

```sh
EXECUTOR_BUILD_VERSION="$(git rev-parse HEAD)" docker compose -f apps/hosted/self-host/compose.yaml up --build --detach
```

### Fork SDK publication to a private registry

Fork versions use `0.0.x-beta.N.shuv.M`. They are forbidden on public npm.
The publish policy requires `EXECUTOR_NPM_REGISTRY` and npm's destination
(`--registry`, or `publishConfig.registry`) to name the same explicitly
configured private registry. The `beta` tag remains required. Public upstream
versions retain the existing `0.0.x-beta.N` policy.

Build the exact host commit, not a newer checkout. Keep its compiled `dist`
unchanged. Publish it with the reviewed release tool and existing publisher
credentials, then run the read-only gate again:

```sh
export EXECUTOR_NPM_REGISTRY=http://executor-registry:4873
# NPM_CONFIG_USERCONFIG points to the existing private publisher npmrc.
node scripts/releases/apps-self-host.ts --package /path/to/exact-host-dist --publish
node scripts/releases/apps-self-host.ts --package /path/to/exact-host-dist
```

`--package` supports historical host artifacts and therefore does not compare
their version with the release tool's own checkout. Verify the host commit and
`framework.release` version/reference digest separately when using it.

Publication applies the current guard explicitly before packing. It publishes
the unchanged tarball, so old compiled packages need no edited lifecycle hook.
**npm does not run `prepublishOnly` when publishing a tarball**; the release tool
runs the reviewed guard against that package first. This is the supported
historical-publication path, not an `--ignore-scripts` escape hatch.
For newly built packages, direct `npm publish ./packages/apps/dist --registry
"$EXECUTOR_NPM_REGISTRY" --tag beta` also runs the packaged guard.

Only a registry 404 permits publication. Existing versions are compared, never
replaced or removed; the `beta` tag may advance. After a failed or interrupted
publish, inspect the registry before retrying. Never change credentials or registry
configuration to force a publish. Do not expose a private registry publicly.
For network-only Verdaccio installs, use its documented Docker network and the
existing publisher npmrc. A typical invocation uses a disposable Node container
on that network with the checkout, compiled artifact and npmrc mounted read-only.
No Executor restart is needed to add a missing SDK version.

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

## Team app registry

This source build includes an organization-only registry in the same database as
your apps. Owners and administrators can open an app's **Publish** dialog to share
its saved Git revision. Set `package.json`'s name to `@organization-slug.executor.community/app-name`
first; the dialog shows the required handle when a name needs repair.

Signed-in organization members can discover publications in **Add app** and read
their selected source. Creating an independent copy requires app-management
permission. Other organizations and anonymous visitors cannot list or download
these publications. The public `/api/registry/*` routes are not enabled on self-host.

Publishing shares only the selected files, not connected accounts, app data or
Git history. Later edits remain private until republished. Unpublishing removes
discovery and source access; already installed copies remain independent.

Fresh hosts create registry tables on first startup. Upgrading registry 1.0.0 to
2.0.0 moves listings from saved package names to owner/label pairs, then removes
the old registry tables. Conflicting labels for the same owner reject the upgrade;
repair the conflict before retrying. Product schema changes commit together, so
a rejected registry upgrade leaves the SDK and registry at their prior versions.
There is no publishing environment-variable switch. Self-host uses its
own registry rather than `EXECUTOR_REGISTRY_URL`; Cloud retains its public registry.

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

The Rust telemetry collector keeps its store in `EXECUTOR_MOTEL_DATA_DIR`, by default
`/app/motel-data` (the setting retains its historical name). The fork Compose configuration
mounts the separate named `motel-data` volume there, retaining traces on replacement.
Standalone image runs need their own separate mount to retain telemetry. Adding a volume
does not copy an existing container's telemetry: preserve and verify those bytes before replacement.
Keep product and telemetry volumes separate; do not remove either during updates.
The collector neither reads nor removes the old nested `motel/` directory. Preserve it
and the exact old image to read pre-cutover history; new Rust traces are separate, not an
import, and cannot be read by Motel. Never reset or restore product data to repair telemetry.

The database records the organization setup created as the instance's root.
An upgrade from an older release records it when the database has exactly one
organization, and leaves it unset otherwise. Releases before the one that added
the record refuse every sign-in once a database holds a second organization, so
do not roll back below it after one exists.

### Operator feedback receiver

Set `EXECUTOR_FEEDBACK_WEBHOOK_URL` to send explicit `feedback.submit` submissions
from the API and Executor app to your own HTTP(S) receiver. Optionally set
`EXECUTOR_FEEDBACK_WEBHOOK_SECRET` for an `Authorization: Bearer` header. Keep both
in your host's secret store; credential-bearing webhook URLs are secrets too.
Use HTTPS except for a trusted local receiver. URLs with embedded username/password
credentials are refused; query-string tokens are supported.

The receiver gets a JSON POST containing `message`, `submittedAt` (ISO 8601),
`organization: { id }`, `user: { id, email? }`, `caller` (available authenticated
source/client/app attribution), and `instanceOrigin`. Unlike anonymous analytics,
this intentionally identifies the sender to the instance operator. Never include
credentials in feedback. `title` ("Executor feedback") and `body` (the first 1,500
message characters plus the sender) also support notification webhook services
without a separate adapter. An app's managed API key may identify its owner, not
the outer agent; unavailable agent attribution is not inferred from message text.

Only a 2xx response within 10 seconds returns `accepted`. Redirects, connection
failures, timeouts and rejection return `FeedbackUnavailable`, without disclosing
the receiver URL or response. Delivery is not retried automatically; after an
ambiguous timeout a caller retry may duplicate feedback. `Idempotency-Key` is a
unique per-delivery ID, not a deduplication key across separate caller submissions.

The webhook takes precedence over feedback analytics and works even with
`DO_NOT_TRACK=1`, `EXECUTOR_DISABLE_ANALYTICS=1`, or no analytics destination.
Other usage analytics are unchanged. With the URL unset or empty, existing
analytics feedback behavior is unchanged, including `FeedbackDisabled` when
analytics are unavailable. Submissions are not stored in the product database:
there is no feedback table, so durable retention belongs to the receiver for now.

### Trace sampling

Recording every span made the telemetry collector the busiest process under load,
so the product samples traces before they reach it. `EXECUTOR_TRACE_SAMPLE_RATE` (0 to 1,
default `0.1`) is the fraction of ordinary traces kept; the decision comes from
the trace ID, so every request of a trace, including the product's requests to
itself through the app process, agrees. A request whose `traceparent` has the
sampled flag is always kept. Whatever the head decision, a trace is kept when
any span fails or a server span answers 5xx, and when it runs for
`EXECUTOR_TRACE_SLOW_MS` (default `1000`) or longer: the product holds an
unsampled trace's ended spans, and the app isolate spans it forwards, in memory
until the trace is decided, and drops them when its last local root ends fast
and successful. Kept-by-tail roots carry `executor.trace.sampled_by` (`error` or
`slow`). Logs and metrics are never sampled. `EXECUTOR_TRACE_SAMPLE_RATE=1`
records everything, as before. The native host passes both variables to the
product with the other `EXECUTOR_*` settings; the app and telemetry collector
processes export no spans of their own.

The product database is PGlite
(PostgreSQL). Bun development stores it at `/app/data/hosted.pglite`; the native
image stores the active database in `/app/data/product` and retains an imported
`hosted.pglite` directory when present. Copying only that legacy directory does
not back up a running native image. The native `executor-host export` command
exports PostgreSQL data from an exclusively locked, stopped product volume; it
does not include the whole product volume or downgrade its schema.

Before an upgrade, stop the server and back up the whole `/app/data` volume,
including key files, Git repositories, builds, app data, and workflow state.
Keep the exact previous image digest as well as the backup. This upgrade changes
the SDK schema to 4.0.17 and registry schema to 2.0.0; the previous binary cannot
start directly on those migrated schemas. To roll back, stop the upgraded server,
restore the complete pre-upgrade backup into a clean volume, and start the exact
previous image with the original origin and secrets. Restoring that snapshot
discards writes made after it; a PostgreSQL export is not a schema rollback.
Back up `/app/motel-data` separately if traces must also survive restoration.
Keep any explicit secret overrides in your secret manager. An existing database with a missing or invalid saved key will not start; restore the original
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
`https://executor.example.com`. The proxy must pass the original `Host` header
and send `X-Forwarded-Proto: https`, as Caddy, nginx's `proxy_set_header`,
Traefik and Cloudflare Tunnel do. The dashboard compares each browser request's
origin with that scheme and host; without them the dashboard page loads but its
reads fail with "Could not reach the server".

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

To use a different client-IP assertion header, also set
`EXECUTOR_TRUSTED_PROXY_HEADER`, for example `cf-connecting-ip` or `x-real-ip`.
This override requires nonempty `EXECUTOR_TRUSTED_PROXIES` and accepts exactly
one IP address from a listed TCP peer. An explicit `x-forwarded-for` override
uses the same right-to-left trusted-hop handling as the default. Missing or
malformed assertions fall back to the socket address. The private
`x-executor-client-ip` header is always overwritten and cannot be configured as
the assertion header. Invalid settings refuse startup; an unset header keeps
the upstream `X-Forwarded-For` behavior with `EXECUTOR_TRUSTED_PROXIES` alone.

Localhost derives app UI addresses automatically. For a public installation,
set `EXECUTOR_APP_UI_BASE_URL` to a separate HTTPS base such as
`https://apps.example.com`. Route that base and its wildcard subdomains to the
same server, with a matching TLS certificate.

`EXECUTOR_APP_UI_HOST_FORMAT` chooses the address shape:

- `nested` (default): `<app-slug>.<organization-slug>.apps.example.com`. The
  certificate must cover two wildcard levels (`*.*.apps.example.com`), which
  Let's Encrypt wildcards and Cloudflare Universal SSL do not.
- `flat`: `<app-slug>--<organization-slug>.apps.example.com`. One label under
  the base, so a single `*.apps.example.com` wildcard certificate covers every
  app. Organization slugs never contain `--`, so the address stays unambiguous
  even when an app slug does. The combined label must fit in 63 characters.

A single-organization installation can drop the organization from its
addresses: set `EXECUTOR_APP_UI_DEFAULT_ORGANIZATION` to that organization's
slug and its apps are published as `<app-slug>.apps.example.com`. Other
organizations keep the format above. Each app still has exactly one address;
the other spellings are refused.

Changing the format or the default organization changes app addresses;
sessions on the old addresses end.

App code can reach only public addresses. Requests to the dashboard origin go
straight to the server, so the built-in Executor app works when that origin
resolves to a private address. Set `EXECUTOR_APPS_ALLOW_PRIVATE_FETCH=true` to
let app code reach other private network addresses. App builds follow the same
setting for every download off the registry's origin: a dependency declared by
tarball URL, and a tarball or redirect the registry's metadata sends elsewhere.
Downloads from the registry's own origin, including a private
`EXECUTOR_NPM_REGISTRY`, work either way.

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

## Unresponsive app code

workerd runs a process's JavaScript on one thread, and the open-source workerd does not enforce CPU
limits. App code therefore runs in its own workerd process: the host starts an app process (the
apps runner, app data and the workflow engine) beside the product process (the product, its
database and the dashboard), and the two talk over private Unix sockets in the host's temporary
directory.

An app that loops without awaiting stops only the app process. Once that process has answered, the
host probes it every `EXECUTOR_APP_WATCHDOG_INTERVAL` seconds (default 3). After
`EXECUTOR_APP_WATCHDOG_FAILURES` silent probes in a row (default 10, about 30 seconds), it logs
`Executor watchdog: the app process did not answer …` and restarts that process alone. The
dashboard, API and MCP keep answering; calls to apps fail until the app process is back, and the
call that was running when it stopped returns an error. Writes an app committed before the restart
are kept; a transaction still open in the stopped call is not. Treat an interrupted tool call or
workflow step as possibly run once already, and use idempotency keys for external effects.

A workflow step that stops the process on every attempt ends its run once it has used its retry
limit (`retries.limit + 1` attempts, 6 by default), instead of running again after every restart.
A workflow body that stops the process between steps ends its run after it starts three times in a
row without reaching a step or a sleep. Sleeping and waking never count toward that limit, because
the body reaches a sleep before each wake.

The product process has its own watchdog. Once the product has answered its first health check, the
host probes `/health` every `EXECUTOR_WATCHDOG_INTERVAL` seconds (default 10). After
`EXECUTOR_WATCHDOG_FAILURES` failed probes in a row (default 9, about 90 seconds), it kills workerd
and exits non-zero. Run the container with a restart policy such as `restart: unless-stopped` (the
bundled compose file sets it), so a fresh process starts. `EXECUTOR_WATCHDOG=off` turns both
watchdogs off.

`EXECUTOR_APP_PROCESS=shared` runs app code in the product's process as earlier releases did; then
only the product watchdog applies, and a looping app restarts the whole host. Exports always use
one process.
