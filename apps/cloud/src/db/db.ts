// ---------------------------------------------------------------------------
// Database service — Postgres through Drizzle
// ---------------------------------------------------------------------------
//
// We use `postgres` (not `pg`) because Cloudflare Workers forbids sharing
// I/O objects across request handlers, and `pg`'s CloudflareSocket silently
// hangs when its Client is reused across requests. postgres.js creates a
// fresh TCP socket per Effect scope, which aligns with Workers' per-request
// I/O model. See personal-notes/pg-cloudflare-sockets-dev.md.
//
// Tests point DATABASE_URL at a PGlite Postgres-compatible socket, so they use
// the same postgres.js path as production.
//
// Migrations are run out-of-band (e.g. via a separate script or CI step),
// not at request time — Cloudflare Workers cannot read the filesystem.

import { env } from "cloudflare:workers";
import { Context, Effect, Layer } from "effect";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase } from "drizzle-orm/pg-core";
import postgres, { type Sql } from "postgres";
import * as cloudSchema from "./schema";
import * as executorSchema from "./executor-schema";

// Exported so every drizzle() call in the cloud app shares one schema
// object. Historically `mcp-session.ts` built its own and forgot to spread
// `executorSchema`, producing runtime "unknown model integration" errors that
// only surfaced in prod. See apps/cloud/src/db/db.schema.test.ts.
export const combinedSchema = { ...cloudSchema, ...executorSchema };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DrizzleDb = PgDatabase<any, any, any>;

export type DbServiceShape = {
  readonly sql?: Sql;
  readonly db: DrizzleDb;
};

type DbResource = DbServiceShape & {
  readonly close: () => Effect.Effect<void>;
};

export const resolveConnectionString = () => {
  // Production should always use Hyperdrive when the binding exists. Keeping
  // DATABASE_URL as a higher-priority fallback made it too easy for a deployed
  // secret to silently bypass Hyperdrive.
  if (env.EXECUTOR_DIRECT_DATABASE_URL === "true" && env.DATABASE_URL) {
    return env.DATABASE_URL;
  }
  return env.HYPERDRIVE?.connectionString || env.DATABASE_URL || "";
};

const makeSql = (): Sql =>
  postgres(resolveConnectionString(), {
    // max=1 is correct for Hyperdrive: one request, one connection. The
    // earlier deadlock under ctx.transaction (outer sql.begin holding the
    // only connection while nested writes pulled fresh ones) is fixed in
    // @executor-js/sdk — nested writes now thread through the active FumaDB tx
    // handle, so they reuse the same connection and never contend with the
    // outer sql.begin.
    max: 1,
    idle_timeout: 0,
    max_lifetime: 60,
    connect_timeout: 10,
    fetch_types: false,
    prepare: true,
    onnotice: () => undefined,
  });

/**
 * Graceful drain window (seconds) handed to `postgres`'s `sql.end`. Small but
 * non-zero: `timeout: 0` closes immediately without waiting for a clean
 * Terminate, which leaves the socket half-closed for the server to reap on its
 * own schedule. A short drain lets postgres.js finish the wire teardown.
 *
 * This is a `Promise.race` CEILING, not a fixed wait: postgres.js races
 * `end({ timeout })` against the actual teardown, and an idle connection's
 * `end()` calls `terminate()` immediately and resolves as soon as the socket
 * closes (sub-millisecond). Awaiting it in the request scope therefore adds no
 * meaningful latency on the common path; the 5s only bounds how long a
 * connection still mid-query can hold the scope open.
 */
export const POSTGRES_END_TIMEOUT_SECONDS = 5;

/**
 * Close a postgres pool and AWAIT its teardown.
 *
 * The `DbService` layers ({@link DbService.Live}, {@link makeDbLayer}) run this
 * as their `acquireRelease` finalizer. The MCP auth seam
 * (`makeMcpOrganizationAuthServices`) builds a FRESH pool on EVERY `/mcp`
 * request, so this finalizer runs per request under sustained load.
 *
 * It used to be fire-and-forget (`Effect.runFork(sql.end({ timeout: 0 }))`),
 * which returned before the connection was actually torn down. The abandoned
 * sockets piled up against the dev PGlite server (effectively single-connection)
 * faster than it reaped them; new connects then queued behind the backlog, so
 * request latency climbed into the tens of seconds and the stack eventually
 * hung — the CI e2e "cloud dev stack degrades after minutes of sustained load"
 * cascade. Awaiting the close bounds the number of live-plus-closing sockets to
 * what is actually in flight. It runs inside the request's own Effect scope, so
 * it respects workerd's per-request I/O rule.
 */
export const closePostgres = (sql: Pick<Sql, "end">): Effect.Effect<void> =>
  Effect.ignore(
    Effect.tryPromise({
      try: () => sql.end({ timeout: POSTGRES_END_TIMEOUT_SECONDS }),
      catch: (cause) => cause,
    }),
  );

const makePostgresResource = (): DbResource => {
  const sql = makeSql();
  return {
    sql,
    db: drizzle(sql, { schema: combinedSchema }) as DrizzleDb,
    close: () => closePostgres(sql),
  };
};

export class DbService extends Context.Service<DbService, DbServiceShape>()(
  "@executor-js/cloud/DbService",
) {
  static Live = Layer.effect(this)(
    Effect.acquireRelease(Effect.sync(makePostgresResource), (resource) => resource.close()),
  );
}

/**
 * A FRESH `DbService` layer (a new layer value on every call). Provide this
 * — rather than the shared `DbService.Live` — anywhere a service is built ONCE
 * by the facade but invoked across many Workers requests (e.g. the MCP
 * org-authorization seam). A single shared `DbService.Live` opens its postgres
 * socket on the first request and reuses it on later ones, which Cloudflare
 * forbids ("Cannot perform I/O on behalf of a different request"). A distinct
 * layer value per call gets its own request-scoped socket, acquired and
 * released within that request.
 */
export const makeDbLayer = (): Layer.Layer<DbService> =>
  Layer.effect(DbService)(
    Effect.acquireRelease(Effect.sync(makePostgresResource), (resource) => resource.close()),
  );
