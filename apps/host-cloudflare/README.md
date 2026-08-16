# @executor-js/host-cloudflare

Executor as a single Cloudflare Worker. The fourth app on the shared
`ExecutorApp.make` facade (alongside cloud, self-host, and local) — same code
paths, different injected providers:

| Seam         | Cloudflare provider                                              |
| ------------ | ---------------------------------------------------------------- |
| **identity** | Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`) — no app login |
| **db**       | D1 (SQLite) via the shared FumaDB assembly                       |
| **engine**   | QuickJS-WASM, in-Worker (no extra binding)                       |
| **mcp**      | Access-JWT auth + the shared in-process session store            |
| **account**  | `/account/me` from the Access principal (members/keys → Access)  |
| **web**      | the shared multiplayer SPA (Workers Static Assets)               |

Single-tenant: every Access-verified principal belongs to the one configured
org. Members and credentials are managed in Cloudflare Access, not in-app.

## Surfaces

- `GET /` — the shared Executor web UI (Sources, Connections, Secrets,
  Policies) — the same shell as cloud/self-host, built by `vite build` into
  `dist/` and served via Workers Static Assets (`single-page-application`
  fallback for client routes).
- `/api/*` — the full Executor API (scopes, sources, secrets, account, …).
- `/mcp` — streamable-HTTP MCP with an `execute` tool.

`run_worker_first` in `wrangler.jsonc` keeps `/api/*` + `/mcp` on the Worker;
everything else is the SPA. Every API/MCP route is gated by the Access JWT (401
without). The SPA's auth context reads `/api/account/me`.

## Deploy

```bash
bunx wrangler login
bun run deploy:setup    # apps/host-cloudflare — provisions D1 + secret + deploys
```

`deploy:setup` (scripts/deploy.sh) is idempotent. It creates or reuses the
`executor` D1 database, writes its id into `wrangler.jsonc`, generates and
uploads `EXECUTOR_SECRET_KEY`, then deploys. It then prints the one manual step.

### The one manual step — Cloudflare Access

After the first deploy, API and MCP requests return 503 and name the missing
Access variables until configuration is complete. In the Zero Trust dashboard:

1. **Access → Applications → Add an application → Self-hosted**
2. Application domain: `executor-cloudflare.<your-subdomain>.workers.dev`
3. Add an Access policy (e.g. _Emails ending in `@yourcompany.com`_)
4. Copy the Application **Audience (AUD)** tag, then:
   ```bash
   bunx wrangler deploy \
     --var ACCESS_AUD:<aud> \
     --var ACCESS_TEAM_DOMAIN:<your-team>.cloudflareaccess.com \
     --var ADMIN_EMAILS:<admin@example.com>
   ```

Now visiting the Worker prompts an Access login; the Worker validates the issued
JWT on every request. Unauthenticated requests return 401. MCP clients present
an Access JWT or `Cf-Access-Client-Id`/`-Secret` service-token headers.

The Access values are live Worker variables, not values in `wrangler.jsonc`.
Wrangler's `keep_vars` option preserves them during later code deploys. Run the
command above again whenever you need to change them.

### Let a service token use one human's personal connections

Cloudflare service-token JWTs have a `common_name` but no human `sub` or email,
so Executor treats them as separate accounts by default. To let one dedicated
MCP token use the same personal connections as a human login, map that token's
`common_name` to the human Access JWT's stable `sub`:

```bash
bunx wrangler deploy \
  --var ACCESS_SERVICE_TOKEN_SUBJECTS:<service-token-client-id>.access=<human-access-sub>
```

The mapping changes only the account that owns user-scoped data. A service
token always remains a `member`; it never inherits the human's admin role or
group claims. Treat the service-token secret as a bearer credential with access
to that human's personal connections.

Read the human `sub` from Cloudflare's `/cdn-cgi/access/get-identity` endpoint
while signed in as that user. The service-token Client ID is the JWT's
`common_name`. Multiple mappings are comma-separated, and duplicate token IDs
are rejected at startup. When adding or changing one mapping, pass the complete
mapping list again because the Worker variable stores the whole value.

## Local development

```bash
# .dev.vars
EXECUTOR_SECRET_KEY=dev-secret-key-0123456789abcdef
ENABLE_DEV_AUTH=true     # bypass Access; every request is a fixed dev admin

bun run build            # vite build -> dist/ (the SPA)
bunx wrangler dev --local   # serves the SPA + Worker API together
```

`bun run dev:web` runs the Vite dev server (HMR) for UI work; point its API at a
running `wrangler dev` if you need live data.

`ENABLE_DEV_AUTH` is a dev-only escape hatch — never set it in a deployed
environment (it disables the Access gate).

## Notes

- The QuickJS engine WASM is vendored into `src/quickjs-engine.wasm` (Workers
  forbid runtime WASM compilation; it must be statically imported). Refresh it
  after bumping the engine with `bun run vendor-wasm`.
- MCP sessions live in-process (one isolate owns a session). The cross-isolate
  upgrade is a Durable Object behind the same `McpSessionStore` seam.
- When Cloudflare's dynamic Worker Loader leaves closed beta, the QuickJS code
  substrate swaps for the dynamic-worker executor behind the `engine` seam — a
  one-Layer change.
