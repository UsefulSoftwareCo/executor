# Self-host Executor

Run Executor in one Docker container. It includes the dashboard, API, MCP server,
PGlite database, and isolated app runtime. You do not need a separate database,
Node, or Bun on the host.

## Start

Install Docker with Docker Compose and Git, then get the public v2 source:

```sh
git clone --depth 1 --branch v2 https://github.com/UsefulSoftwareCo/executor.git executor-v2
cd executor-v2
```

Use your secret manager to supply these environment variables to Docker Compose:

| Variable                  | Value                                                                       |
| ------------------------- | --------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`      | A saved random secret of at least 32 characters.                            |
| `EXECUTOR_ENCRYPTION_KEY` | A separate saved random key: 32 bytes encoded as 64 hexadecimal characters. |

Keep these values stable across restarts and upgrades. The encryption key is needed
to read connected account credentials. A database backup alone cannot recover them.

For a local installation:

```sh
export BETTER_AUTH_URL=http://localhost:4400
docker compose -f apps/hosted/self-host/compose.yaml config --quiet
docker compose -f apps/hosted/self-host/compose.yaml up --build --detach
```

The configuration check fails if either required secret is missing. It does not
print the resolved configuration or secret values.

Open [http://localhost:4400](http://localhost:4400) and complete the first-admin setup.
Self-host uses password login by default. Add an app, then connect an account from
the app page. For MCP client setup, open **Connect** in the sidebar and follow the
instructions for your client. MCP uses browser sign-in.

The health endpoint is [http://localhost:4400/health](http://localhost:4400/health).

## Data and updates

The named `pglite-data` volume stores the database, app source, builds, app data,
and diagnostics under `/app/data`. Keep one server instance per data volume.

Before an upgrade, stop the server and back up the volume. Keep both configured
secrets in your secret manager. To build and start an updated version:

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
cache. The current v2 install path builds from source; these commands do not
depend on a published container image.
