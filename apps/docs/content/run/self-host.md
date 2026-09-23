---
title: Self-host with Docker
description: "Run the whole hosted server in one container, with an embedded database and no separate Postgres, queue or proxy, on your own infrastructure."
---

Self-host is the hosted server on your own infrastructure. One container holds
the API, the MCP endpoint, authentication, the app runtime and the dashboard,
over an embedded PGlite database. There is no separate database, worker, queue
or proxy to run.

It has the same organizations, invitations and browser sign-in as hosted. It
does not offer the hosted Google and GitHub sign-in buttons.

## Configure it

No environment variables are needed for local Docker or a Railway service with a
public domain. On first boot, Executor generates separate session and encryption
keys and saves them in the data volume. Later boots reuse those files.

These settings override the defaults:

| Variable                             | Required | Purpose                                                                  |
| ------------------------------------ | -------- | ------------------------------------------------------------------------ |
| `BETTER_AUTH_URL`                    | no       | Public origin. Defaults to Railway's HTTPS domain, then `http://localhost:4400` (or `PORT`). |
| `BETTER_AUTH_SECRET`                 | no       | Override the saved session secret. At least 32 characters. Rotating it signs everyone out. |
| `EXECUTOR_ENCRYPTION_KEY`            | no       | Override the saved credential encryption key. Exactly 64 hexadecimal characters. |
| `EXECUTOR_ENVIRONMENT`               | no       | Label for this deployment. The default is `self-host`.                   |
| `EXECUTOR_APP_UI_BASE_URL`           | no       | HTTPS origin that serves app web pages. See below.                       |
| `EXECUTOR_APPS_ALLOW_PRIVATE_FETCH`  | no       | Let app code reach your private network. See below.                      |
| `SSO_DISCOVERY_URL`                  | no       | OIDC discovery document. Leave it empty to keep SSO off.                 |
| `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET` | no       | Credentials for that identity provider.                                  |
| `SSO_ALLOWED_DOMAINS`                | no       | Comma-separated email domains allowed to join through SSO.               |

App code runs in an isolate whose `fetch` reaches only public addresses, the same
as Executor Cloud. The default follows `BETTER_AUTH_URL`: a public origin keeps
private fetch off, and a loopback, private or single-label origin turns it on,
because the bundled Executor app must reach the dashboard to use its own tools.
A startup line records it when the derived default turns private fetch on. Set
`EXECUTOR_APPS_ALLOW_PRIVATE_FETCH` yourself to override that default. Every app
in the instance shares that network position, so grant it deliberately.

`BETTER_AUTH_URL` must match the scheme, host and port you actually use. If it
does not, browser sign-in is rejected as an invalid origin. Railway detection uses `RAILWAY_PUBLIC_DOMAIN`. Origins are never inferred
from a request header. Set `BETTER_AUTH_URL` when you use a custom domain.

Keep `<BETTER_AUTH_URL>/api/oauth/callback` reachable; connecting a provider
account by OAuth uses it. The SSO callback is
`<BETTER_AUTH_URL>/api/auth/callback/sso`.

Tracing is configured separately and is off until you set an endpoint. See
[Tracing](/run/tracing).

## Run it

Use `ghcr.io/usefulsoftwareco/executor-selfhost:beta` for Executor v2 on Linux
amd64 or arm64. The `latest` tag still serves v1. Start with a new volume;
this image does not migrate an existing v1 database.

For a local installation, run:

```bash
docker pull ghcr.io/usefulsoftwareco/executor-selfhost:beta
docker run --detach --name executor-v2 --init --restart unless-stopped \
  --publish 127.0.0.1:4400:4400 \
  --volume executor-v2-data:/app/data \
  ghcr.io/usefulsoftwareco/executor-selfhost:beta
```

Open `http://localhost:4400`. For a server outside Railway, set `BETTER_AUTH_URL`
to its exact HTTPS origin. Add `--env NAME` for any settings above.
To pin a release, replace `beta` with `beta-<full Git commit SHA>`.

The container publishes port `4400` on loopback only, as
`127.0.0.1:4400`. Put your own TLS terminator in front of it and forward to that
port. Startup initializes the embedded database before it opens HTTP, so the
first boot takes a moment.

Stop it with:

```bash
docker stop executor-v2
```

The first person to finish setup becomes the owner, and one organization is
created. After that, people join through invitations, or through SSO when you
have configured it.

## Deploy on Railway

1. Create a service from `ghcr.io/usefulsoftwareco/executor-selfhost:beta`.
2. Attach a new persistent volume at `/app/data`.
3. Generate a public domain in the service's networking settings. Route it to port `8080`, which Railway supplies through `PORT`. If you override `PORT`, use that value.
4. Set the Railway healthcheck path to `/health`, with a startup timeout of 120 seconds.
5. Deploy (or redeploy if the service already started). This loads the new public domain into the server. Open that domain to create the first administrator.

No database service or secret variables are needed. Executor reads
`RAILWAY_PUBLIC_DOMAIN` and `PORT`. The container prepares the root-owned volume,
then runs the server as the unprivileged `node` user. You do not need
`RAILWAY_RUN_UID=0` or a custom start command. Keep one replica per volume.

For a custom domain, set `BETTER_AUTH_URL` to that exact HTTPS origin. App web
pages need the additional wildcard domain described below; the dashboard, API,
and MCP endpoint use the service domain.

## Storage

Everything that must survive a restart lives in the named volume `executor-v2-data`,
mounted at `/app/data`. This includes the database, app source and builds, app
data, diagnostics, and generated keys (`auth-secret.key` and `encryption.key`).
The key files are readable only by the server user. Back up the whole volume.

If you supply keys through environment variables, keep those values in your
secret manager as well; Executor does not save those overrides to disk. Keep
the same key source across upgrades. If a saved key is missing or invalid for
an existing database, startup fails instead of creating a replacement. Restore
the original key. Changing the encryption key makes existing credentials unreadable.

Back up by snapshotting that volume. Do not remove it when you update the image.
Before updating, stop the container and back up the volume. Pull the new image,
remove only the stopped container with `docker rm executor-v2`, and repeat the
run command with the same volume and secrets.

## Build from source

The public repository also includes a Compose setup that builds locally:

```bash
git clone --depth 1 --branch v2 https://github.com/UsefulSoftwareCo/executor.git executor-v2
cd executor-v2
docker compose -f apps/hosted/self-host/compose.yaml up --build -d
```

Compose also works without environment variables. This setup uses a separate named
volume, `pglite-data`; do not confuse it with the published-image example above.

## Serving app web pages

Some apps ship a web page. Set `EXECUTOR_APP_UI_BASE_URL` to an HTTPS origin
with no trailing slash, and point a wildcard DNS record and certificate at your
proxy:

```bash
EXECUTOR_APP_UI_BASE_URL=https://apps.example.net
```

Each page is served at `<app-slug>.<organization-slug>.<base>`, forwarded to
container port 4400. That whole first label must fit in 63 characters, so keep
app and organization slugs short. On localhost the origin is derived for you and
you do not need to set this.

## Running without Docker

You can run the same server directly with Node. Data persists under
`.local/hosted`; set `EXECUTOR_DATA_DIR` to choose a different parent directory.
`HOST` defaults to `0.0.0.0` and `PORT` to `4400`.

Self-host needs no `DATABASE_URL`, no separate Postgres, and no migration
command.

## Connect an agent

The MCP endpoint is `<your origin>/mcp`. Sign-in happens in the browser, the
same way as hosted. See [Add an MCP client](/mcp-clients).
