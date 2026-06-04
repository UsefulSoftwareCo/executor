# Self-hosted Executor

The single-container, self-hostable Executor server: the typed API, the MCP
server, Better Auth (cookie / bearer / API-key + MCP OAuth), QuickJS code
execution, and the web UI — all in one process over a libSQL (SQLite) file. No
external database, worker, or proxy.

## Run it

```bash
# From this directory:
docker compose up -d --build
# then open http://localhost:4788 and create the admin account
```

No configuration is required. A fresh instance shows a setup screen; the first
person to create an account becomes the owner. After that, people join via
single-use invite links you mint from the **Admin** page, and self-service
signup is closed.

See [`.env.example`](./.env.example) for optional settings (most importantly
`EXECUTOR_WEB_BASE_URL` behind a domain / TLS) and the full
[Self-Hosting guide](../../docs/self-hosting/guide.mdx) for first-run, inviting
people, backups, reverse-proxy setup, and upgrades.

## Develop

```bash
bun run build                  # build the SPA (regenerates the route tree)
bun run src/serve.ts           # serve the built app
bun run --filter @executor-js/host-selfhost test   # the test suite
```

## Layout

```
src/
  app.ts            the ExecutorApp.make composition root
  serve.ts          the Bun server entry
  config.ts         env + zero-config secret/key persistence
  auth/             Better Auth wiring, the signup gate, invite codes, seed
  account/          the AccountProvider seam (members/roles via the org plugin)
  admin/            the invite-code admin HttpApi
  system/           public /api/health + /api/setup-status
  db/ · mcp/ · execution.ts · plugins.ts · observability.ts
web/                the TanStack Router SPA (setup, login, join, admin, …)
```
