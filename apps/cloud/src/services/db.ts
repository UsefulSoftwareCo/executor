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
// Node integration tests use Drizzle's PGlite driver directly. Workerd still
// uses postgres.js over the PGlite socket, which is the path production uses
// through Hyperdrive.
//
// Migrations are run out-of-band (e.g. via a separate script or CI step),
// not at request time — Cloudflare Workers cannot read the filesystem.

import { env } from "cloudflare:workers";
import { Context, Effect, Layer } from "effect";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase } from "drizzle-orm/pg-core";
import postgres, { type Sql } from "postgres";
import { collectTables } from "@executor-js/sdk";
import executorConfig from "../../executor.config";
import * as cloudSchema from "./schema";
import * as executorSchema from "./executor-schema";
import { createPgliteFumaDb } from "./pglite";
import { ensureCloudSchema } from "./schema-init";

// Exported so every drizzle() call in the cloud app shares one schema
// object. Historically `mcp-session.ts` built its own and forgot to spread
// `executorSchema`, producing runtime "unknown model source" errors that
// only surfaced in prod. See apps/cloud/src/services/db.schema.test.ts.
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

type DirectPgliteRuntime = {
  readonly db: DrizzleDb;
};

let directPgliteRuntime: Promise<DirectPgliteRuntime> | undefined;

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

const getDirectPgliteRuntime = async (): Promise<DirectPgliteRuntime> => {
  directPgliteRuntime ??= (async () => {
    const runtime = await createPgliteFumaDb({
      tables: collectTables(executorConfig.plugins({})),
      namespace: "executor_cloud",
    });
    await ensureCloudSchema(runtime.drizzle);
    return { db: runtime.drizzle as DrizzleDb };
  })();
  return directPgliteRuntime;
};

const makeDirectPgliteResource = async (): Promise<DbResource> => {
  const runtime = await getDirectPgliteRuntime();
  return {
    db: runtime.db,
    close: () => Effect.void,
  };
};

export const warmDirectPgliteDb = async (): Promise<void> => {
  await getDirectPgliteRuntime();
};

const makePostgresResource = (): DbResource => {
  const sql = makeSql();
  return {
    sql,
    db: drizzle(sql, { schema: combinedSchema }) as DrizzleDb,
    close: () =>
      Effect.sync(() => {
        void Effect.runFork(
          Effect.ignore(
            Effect.tryPromise({
              try: () => sql.end({ timeout: 0 }),
              catch: (cause) => cause,
            }),
          ),
        );
      }),
  };
};

export class DbService extends Context.Service<DbService, DbServiceShape>()(
  "@executor-js/cloud/DbService",
) {
  static Production = Layer.effect(this)(
    Effect.acquireRelease(Effect.sync(makePostgresResource), (resource) => resource.close()),
  );

  static TestDirectPglite = Layer.effect(this)(
    Effect.acquireRelease(Effect.promise(makeDirectPgliteResource), (resource) => resource.close()),
  );

  static Live = this.Production;
}
