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

## Delegated machine access

When delegated binding is enabled, Cloudflare Access service tokens can be
bound to an Executor delegated grant.
The grant is a separate, bounded permission for a verified member: it names
the exact tools and optional connections the machine may use, has an expiry,
and is checked again for every call and continuation. A service token does not
inherit the Access user's administrator role.

In an enabled deployment, the human starts the binding from the account's
delegated-credential surface.
Executor requires a one-time possession proof before the external token is
accepted. Store the Access client secret only in the machine's secret manager;
Executor stores a reference and proof digest, not the secret. Disable the
service token in Access and revoke the Executor grant during offboarding.

The existing personal API-key routes remain separate. This host's source
contract exposes `/account/api-keys`; an enabled delegated surface uses
`/account/delegated-credentials`.

Issuance is gated by `DELEGATED_CREDENTIAL_ISSUANCE`, which defaults to
disabled. Keep the gate unset during rollout and local runs that do not provide
the account and proof adapters; a missing adapter fails closed. The local
Cloudflare worker still uses dev auth and cannot stand in for Access proof.

The worker accepts these delegated-credential settings (durations are integer
milliseconds):

```text
DELEGATED_CREDENTIAL_ISSUANCE=true       # explicit opt-in; default is disabled
DELEGATED_MAX_TTL_MS=7776000000          # default and hard maximum: 90 days
DELEGATED_RECENT_AUTH_MAX_AGE_MS=300000  # default: 5 minutes
DELEGATED_RECENT_AUTH_CLAIM=auth_time    # signed Access/IdP claim name
```

`DELEGATED_RECENT_AUTH_CLAIM` may name a signed top-level JWT claim or a claim
inside Access's signed `custom` object. The default `auth_time` represents the
IdP authentication event. `iat` is token issuance time and is not accepted as
recent-login proof. Missing or stale assurance fails closed. A configured TTL
must be a positive integer no greater than the 90-day hard maximum; malformed
configuration stops worker startup.

Revoke-all ordinarily leaves a verified member eligible to consent again. An
organization administrator may request `disableTarget: true` to revoke all
current grants and create a durable Access verification tombstone after the
revocation commits. Use that explicit action when offboarding a member; later
requests for that target fail closed until the host's verified-member registry
allows it again.

Human management also requires a recent login assurance in the signed Access
JWT. Cloudflare's standard application token documents `iat` as token issuance
time, so this host never treats `iat` as a fresh-login signal. Configure the
identity provider to emit a signed Unix-seconds claim (for example `auth_time`,
including under Access's signed `custom` claim) and set
`DELEGATED_RECENT_AUTH_CLAIM` to that name. Requests without the claim fail
closed; `DELEGATED_RECENT_AUTH_MAX_AGE_MS` controls the accepted age.

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

The local Cloudflare harness uses `ENABLE_DEV_AUTH=true`, which intentionally
represents one fixed administrator and cannot prove Access service-token
claims, issuer checks, or machine identity. Run the Access-specific checks
against a local Access-compatible issuer when one is available; do not point
the harness at a live Cloudflare tenant from an e2e run.

## Notes

- The QuickJS engine WASM is vendored into `src/quickjs-engine.wasm` (Workers
  forbid runtime WASM compilation; it must be statically imported). Refresh it
  after bumping the engine with `bun run vendor-wasm`.
- MCP sessions live in-process (one isolate owns a session). The cross-isolate
  upgrade is a Durable Object behind the same `McpSessionStore` seam.
- When Cloudflare's dynamic Worker Loader leaves closed beta, the QuickJS code
  substrate swaps for the dynamic-worker executor behind the `engine` seam — a
  one-Layer change.
