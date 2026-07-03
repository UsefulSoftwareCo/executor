# Open Agents production storage

This app must use storage resources created only for the `goaugment/openagents` Vercel project. Do not attach shared Augment, Executor, or other product resources.

## Resources

Create and connect these resources in Vercel:

| Resource | Required name | Purpose |
| --- | --- | --- |
| Vercel Postgres / Neon | `openagents-postgres` | App DB, executor metadata, automations, sessions, agents, skills |
| Vercel KV / Redis | `openagents-redis` | Rate limiting and Redis-backed runtime state |

Connect both resources to the `openagents` project only. If Vercel offers to reuse an existing Augment resource, cancel and create the Open Agents resource instead.

## Project wiring

The project must be linked as:

- Scope: `goaugment`
- Project: `openagents`
- Root directory: `apps/open-agents`
- Framework: Next.js
- Install command: `bun install --frozen-lockfile`
- Build command: `bun run build`
- Node.js: `24.x`

Pull production settings before validating or building locally:

```bash
vercel pull --yes --environment=production --scope goaugment
bun run --cwd apps/open-agents prod:verify-env
vercel build --prod --scope goaugment
```

`prod:verify-env` checks the linked Vercel project settings, required Postgres/Redis/auth/model/sandbox env vars, requires `OPEN_AGENTS_AUTH_MODE=oauth` for production Vercel OAuth users, and blocks known shared-resource names such as `augment-postgres`, `augment-redis`, `executor-postgres`, and `executor-redis` in storage connection strings. It also validates optional session CLI secret shapes for Braintrust, Datadog Pup, and Snowflake when non-empty values are available locally. Vercel may pull encrypted values such as `BETTER_AUTH_SECRET`, `VERCEL_APP_CLIENT_SECRET`, and optional CLI secrets as empty local placeholders; the script treats those as valid only when the keys exist.

## Required production env groups

Postgres must provide the Vercel Postgres/Neon variables (`POSTGRES_URL`, `POSTGRES_PRISMA_URL`, `POSTGRES_URL_NON_POOLING`, `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `PG*`, `POSTGRES_*`, `NEON_PROJECT_ID`).

Redis must provide both Redis and KV-compatible variables (`REDIS_URL`, `KV_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`).

The app runtime also needs `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, Vercel OAuth (`NEXT_PUBLIC_VERCEL_APP_CLIENT_ID`, `VERCEL_APP_CLIENT_SECRET`), `OPEN_AGENTS_AUTH_MODE=oauth`, `OPEN_AGENTS_ALLOW_PUBLIC_REPO_SESSIONS`, `OPEN_AGENTS_RESOURCE_PROFILE`, and Vercel OIDC (`VERCEL_OIDC_TOKEN`) for sandbox access and AI Gateway access during local production builds.

Optional integrations such as GitHub App, Slack, Linear, and Vercel OAuth can be added separately. The production smoke path should still boot, create sessions, run executor tools, clone public GitHub repositories when public repo sessions are enabled, and run automations without those optional integrations.

Optional sandbox CLI integrations can be enabled with JSON secrets:

- `OPEN_AGENTS_BRAINTRUST_CLI_SECRET`: `apiKey`; optional `apiUrl`, `appUrl`, `org`, `project`.
- `OPEN_AGENTS_DATADOG_PUP_CLI_SECRET`: `apiKey`, `appKey`; optional `site`.
- `OPEN_AGENTS_SNOWFLAKE_CLI_SECRET`: `account`, `private_key`, `role`, `user`, `warehouse`; optional `database`, `schema`.
