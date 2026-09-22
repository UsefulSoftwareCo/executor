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

During the beta the image is built from the repository rather than pulled from a
registry.

```bash
git clone https://github.com/UsefulSoftwareCo/executor-next
cd executor-next
docker compose -f apps/hosted/self-host/compose.yaml up --build -d
```

Supply the three required variables in the environment of that command, or in a
`.env` file beside it.

```bash
BETTER_AUTH_URL=https://executor.example.com
BETTER_AUTH_SECRET=<stable random secret of at least 32 characters>
EXECUTOR_ENCRYPTION_KEY=<stable 64-character hexadecimal key>
```

The container publishes port `4400` on loopback only, as
`127.0.0.1:4400`. Put your own TLS terminator in front of it and forward to that
port. Startup initializes the embedded database before it opens HTTP, so the
first boot takes a moment.

Stop it with:

```bash
docker compose -f apps/hosted/self-host/compose.yaml down
```

The first person to finish setup becomes the owner, and one organization is
created. After that, people join through invitations, or through SSO when you
have configured it.

## Storage

Everything that must survive a restart lives in the named volume `pglite-data`,
mounted at `/app/data`. That is the database, the encrypted credentials and the
diagnostics.

Back up by snapshotting that volume. Do not remove it when you update the image.

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

## What is coming later

- A published container image, so self-hosting does not need a clone and a
  build.
