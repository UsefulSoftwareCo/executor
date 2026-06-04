# host-nice — implementation status

`@executor-js/host-nice` is a fork of `apps/host-selfhost` re-targeted to run on
**nice-chatbot's Postgres** and **Better Auth identity**, with **multi-org**
enabled — the self-hosted executor hub from
`nice-chatbot/plans/EXECUTOR_SELFHOST_FINAL_PLAN.md`.

This is a **Phase-0 work-in-progress**. It does not boot yet end-to-end; the
storage foundation is migrated, the app/auth wiring is next.

## Done (Phase 0 foundation)

- **`package.json`** — renamed to `@executor-js/host-nice`; libSQL deps swapped
  for Postgres (`postgres`, `pg`, `kysely`).
- **`src/config.ts`** — Postgres config (`POSTGRES_URL`/`DATABASE_URL` + a
  dedicated `executor` schema), **multi-org** (no single-org pin),
  optional **OIDC delegation** to nice-chatbot, shared `BETTER_AUTH_SECRET` +
  cookie domain.
- **`src/db/postgres-db.ts`** — the storage swap: postgres-js + fumadb
  `provider: "postgresql"`, idempotent schema bring-up into the `executor`
  schema. Same `DbProvider` tag/shape as host-selfhost's `SelfHostDb`, so the
  rest of the app needs no changes beyond the import.
- **`scripts/migrate-smoke.ts`** — verifies the real executor table set migrates
  through the Postgres path and round-trips.

## Pending (next, tracked in the plan's phases)

- **Rewire `src/app.ts`** to use `createHostNiceDb` / `HostNiceDbProvider`
  (currently still imports the copied libSQL `self-host-db.ts`).
- **`src/auth/better-auth.ts`** — swap LibsqlDialect → Postgres (pg Pool with
  `search_path=executor`); **remove the single-org `databaseHooks.session.create
  .before` pin** (the exact multi-org un-pin); keep
  `organization`+`admin`+`apiKey`+`bearer`+`mcp` plugins.
- **`src/auth/seed.ts`** — make the org/admin seed optional (default-org +
  bootstrap-admin only when configured) instead of mandatory single-org.
- **SSO bridge** (`genericOAuth`/`sso`) so login delegates to nice-chatbot
  (Phase 1).
- Remove the now-unused libSQL `self-host-db.ts` copy once `app.ts` is rewired.

## Verification

- Local Postgres 16 + `scripts/migrate-smoke.ts` proves the fumadb Postgres
  path (the plan's residual risk #2). Run:
  ```bash
  POSTGRES_URL=postgres://postgres@127.0.0.1:5433/executor_test \
    bun run apps/host-nice/scripts/migrate-smoke.ts
  ```
