import { type PgDatabase } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { type FumaDB } from "fumadb";
// Mirrors apps/cloud's `DrizzleDb`: the fuma drizzle adapter accepts a loosely
// typed PgDatabase; the precise postgres-js generics don't structurally match
// `ExecutableDrizzleDb`.
// oxlint-disable-next-line no-explicit-any
type DrizzleFumaDb = PgDatabase<any, any, any>;
import {
  createDrizzleRuntimeSchemaFromTables,
  ensureDrizzleRuntimeSchemaFromTables,
} from "fumadb/adapters/drizzle";
import { type schema as fumaSchema, type RelationsMap } from "fumadb/schema";
import postgres, { type Sql } from "postgres";
import { Context, Effect, Layer } from "effect";

import {
  collectTables,
  createExecutorFumaDb,
  DbProvider,
  type ExecutorDbHandle,
} from "@executor-js/api/server";
import type { FumaDb, FumaTables } from "@executor-js/sdk";

import { HOST_NICE_NAMESPACE, HOST_NICE_SCHEMA_VERSION } from "../config";

// ---------------------------------------------------------------------------
// Postgres executor DB factory for host-nice.
//
// This is the host-nice analogue of host-selfhost's libSQL `self-host-db.ts`,
// re-targeted to Postgres so the host shares nice-chatbot's Postgres instance.
// It mirrors apps/cloud's `provider: "postgresql"` fumadb assembly but, unlike
// cloud (which runs migrations out-of-band because Cloudflare Workers cannot
// touch the filesystem), it keeps host-selfhost's idempotent
// `ensureDrizzleRuntimeSchemaFromTables` schema bring-up: a single long-lived
// Bun process opens one postgres-js handle and self-migrates at boot.
//
// Schema isolation: every executor table lives in a dedicated Postgres schema
// (default `executor`) so it never collides with nice-chatbot's `public`
// tables in the same database. The schema is created if missing and pinned via
// the connection `search_path`. Better Auth opens its OWN pg connection (see
// better-auth.ts) with the same `search_path`, exactly like host-selfhost runs
// two libSQL connections over one file.
// ---------------------------------------------------------------------------

type HostNiceFumaSchema<TTables extends FumaTables> = ReturnType<
  typeof fumaSchema<string, TTables, RelationsMap<TTables>>
>;

export interface HostNiceDbHandle<TTables extends FumaTables = FumaTables> {
  readonly db: FumaDb<HostNiceFumaSchema<TTables>>;
  readonly fuma: FumaDB<HostNiceFumaSchema<TTables>[]>;
  readonly drizzle: DrizzleFumaDb;
  /** The postgres-js client for this handle (executor `search_path`). */
  readonly sql: Sql;
  /** Connection string Better Auth re-opens its own pg pool against. */
  readonly url: string;
  /** Postgres schema the executor tables live in (default `executor`). */
  readonly schema: string;
  readonly close: () => Promise<void>;
}

export interface CreatePostgresExecutorDbOptions<TTables extends FumaTables = FumaTables> {
  readonly tables: TTables;
  readonly namespace: string;
  readonly version?: string;
  readonly url: string;
  /** Postgres schema for executor tables. Defaults to `executor`. */
  readonly schema?: string;
}

const quoteIdent = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;

export const createPostgresExecutorDb = async <const TTables extends FumaTables>(
  options: CreatePostgresExecutorDbOptions<TTables>,
): Promise<HostNiceDbHandle<TTables>> => {
  const version = options.version ?? HOST_NICE_SCHEMA_VERSION;
  const schema = options.schema ?? "executor";

  // Pin every statement on this connection to the executor schema. A fresh
  // bootstrap connection (no search_path) creates the schema first so the
  // pinned pool can target it.
  const bootstrap = postgres(options.url, { max: 1, onnotice: () => undefined });
  await bootstrap.unsafe(`create schema if not exists ${quoteIdent(schema)}`);
  await bootstrap.end({ timeout: 5 });

  const sql = postgres(options.url, {
    max: 10,
    onnotice: () => undefined,
    connection: { search_path: schema },
  });

  const runtimeSchema = createDrizzleRuntimeSchemaFromTables({
    tables: options.tables,
    namespace: options.namespace,
    version,
    provider: "postgresql",
  });
  // Natural postgres-js type (structurally an `ExecutableDrizzleDb`, like the
  // libSQL path); only the exported handle field is widened to `DrizzleFumaDb`.
  const drizzleDb = drizzle(sql, { schema: runtimeSchema });

  // Idempotent schema bring-up (the drizzle adapter has no versioned migrator).
  await ensureDrizzleRuntimeSchemaFromTables(drizzleDb, {
    tables: options.tables,
    namespace: options.namespace,
    version,
    provider: "postgresql",
  });

  const { db, fuma } = createExecutorFumaDb(drizzleDb, {
    tables: options.tables,
    namespace: options.namespace,
    version,
    provider: "postgresql",
  });

  return {
    db,
    fuma,
    drizzle: drizzleDb as DrizzleFumaDb,
    sql,
    url: options.url,
    schema,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
};

// ---------------------------------------------------------------------------
// Long-lived DB layer (built once at boot; lives for the process). Same shape
// and tag semantics as host-selfhost's `SelfHostDb`, so the rest of the app
// (execution.ts, the MCP session store, the shared `DbProvider` seam) needs no
// changes — only the storage driver underneath differs.
// ---------------------------------------------------------------------------

export class HostNiceDb extends Context.Service<HostNiceDb, HostNiceDbHandle>()(
  "@executor-js/host-nice/HostNiceDb",
) {}

export interface HostNiceDbLayerOptions {
  readonly url: string;
  readonly schema?: string;
  readonly namespace?: string;
  readonly version?: string;
}

export const createHostNiceDb = (options: HostNiceDbLayerOptions): Promise<HostNiceDbHandle> =>
  createPostgresExecutorDb({
    tables: collectTables(),
    namespace: options.namespace ?? HOST_NICE_NAMESPACE,
    version: options.version ?? HOST_NICE_SCHEMA_VERSION,
    url: options.url,
    schema: options.schema,
  });

// Shared DbProvider seam: re-expose the long-lived handle under the shared
// `DbProvider` tag. Release is owned by `HostNiceDb`, so this projection does
// not re-close.
export const HostNiceDbProvider: Layer.Layer<DbProvider, never, HostNiceDb> = Layer.effect(
  DbProvider,
)(
  Effect.map(
    HostNiceDb.asEffect(),
    (handle): ExecutorDbHandle => ({
      db: handle.db,
      fuma: handle.fuma,
      close: handle.close,
    }),
  ),
);
