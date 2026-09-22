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

Three settings are required. The container will not start without them.

| Variable                             | Required | Purpose                                                                  |
| ------------------------------------ | -------- | ------------------------------------------------------------------------ |
| `BETTER_AUTH_URL`                    | yes      | The exact public origin you load in the browser.                         |
| `BETTER_AUTH_SECRET`                 | yes      | Session secret. At least 32 characters. Rotating it signs everyone out.  |
| `EXECUTOR_ENCRYPTION_KEY`            | yes      | Key that encrypts stored credentials. Exactly 64 hexadecimal characters. |
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
does not, browser sign-in is rejected as an invalid origin. Origins are never
inferred from a request header.

Keep `<BETTER_AUTH_URL>/api/oauth/callback` reachable; connecting a provider
account by OAuth uses it. The SSO callback is
`<BETTER_AUTH_URL>/api/auth/callback/sso`.

Tracing is configured separately and is off until you set an endpoint. See
[Tracing](/run/tracing).

## Run it

Use `ghcr.io/usefulsoftwareco/executor-selfhost:beta` for Executor v2 on Linux
amd64 or arm64. The `latest` tag still serves v1. Start with a new volume;
this image does not migrate an existing v1 database.

Supply the three required variables through your secret manager, then run:

```bash
docker pull ghcr.io/usefulsoftwareco/executor-selfhost:beta
docker run --detach --name executor-v2 --init --restart unless-stopped \
  --publish 127.0.0.1:4400:4400 \
  --volume executor-v2-data:/app/data \
  --env BETTER_AUTH_URL --env BETTER_AUTH_SECRET --env EXECUTOR_ENCRYPTION_KEY \
  ghcr.io/usefulsoftwareco/executor-selfhost:beta
```

Use `BETTER_AUTH_URL=http://localhost:4400` for a local instance, or your exact
HTTPS origin for a server. Add `--env NAME` for any optional settings above.
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

## Storage

Everything that must survive a restart lives in the named volume `executor-v2-data`,
mounted at `/app/data`. That is the database, the encrypted credentials and the
diagnostics.

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

Supply the same required variables. This Compose setup uses a separate named
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
