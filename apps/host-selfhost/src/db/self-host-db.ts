import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { type FumaDB } from "@executor-js/fumadb";
import {
  createDrizzleRuntimeSchemaFromTables,
  ensureDrizzleRuntimeSchemaFromTables,
} from "@executor-js/fumadb/adapters/drizzle";
import { type schema as fumaSchema, type RelationsMap } from "@executor-js/fumadb/schema";
import { Context, Effect, Layer } from "effect";

import {
  collectTables,
  createExecutorFumaDb,
  DbProvider,
  type ExecutorDbHandle,
} from "@executor-js/api/server";
import type { FumaDb, FumaTables } from "@executor-js/sdk";

import { SELF_HOST_NAMESPACE, SELF_HOST_SCHEMA_VERSION } from "../config";

// ---------------------------------------------------------------------------
// SQLite executor DB factory, inline (like apps/local's sqlite-fumadb.ts and
// apps/cloud's fuma.ts — each app owns its DB wiring; there is no shared
// storage package). Differences from apps/local: busy_timeout + synchronous
// pragmas for the multi-user HTTP server, and the idempotent
// `ensureDrizzleRuntimeSchemaFromTables` schema-ensure (the drizzle adapter
// has no versioned migrator). Built ONCE for the process; the per-request
// executor reuses this long-lived handle's `db`.
//
// Driver: libSQL (@libsql/client + drizzle-orm/libsql), not bun:sqlite, so the
// self-host server runs on Node AND Bun (and the same code path serves edge by
// swapping the `file:` URL for an https Turso URL). Better Auth opens its OWN
// libSQL connection (LibsqlDialect) to the SAME file: URL — see better-auth.ts.
// Because libSQL connections are NOT a single shared in-process handle the way
// bun:sqlite's was, the WAL/busy_timeout/synchronous/foreign_keys PRAGMAs are
// re-applied PER connection (here, and again in the Better Auth dialect path).
// ---------------------------------------------------------------------------

/**
 * Build a `file:` libSQL URL from a filesystem path. libSQL requires an
 * absolute path for `file:` URLs; `:memory:` passes through unchanged.
 */
export const toLibsqlFileUrl = (path: string): string =>
  path === ":memory:" ? path : `file:${resolve(path)}`;

type SelfHostFumaSchema<TTables extends FumaTables> = ReturnType<
  typeof fumaSchema<string, TTables, RelationsMap<TTables>>
>;

export interface SelfHostDbHandle<TTables extends FumaTables = FumaTables> {
  readonly db: FumaDb<SelfHostFumaSchema<TTables>>;
  readonly fuma: FumaDB<SelfHostFumaSchema<TTables>[]>;
  readonly drizzle: LibSQLDatabase<Record<string, unknown>>;
  /**
   * The libSQL client for this handle's `file:` URL. Better Auth opens its own
   * separate connection to the same file via LibsqlDialect; the seed reads
   * Better Auth's tables through this client (async), so the URL is carried
   * alongside so callers can hand it to the dialect.
   */
  readonly client: Client;
  readonly url: string;
  readonly close: () => Promise<void>;
}

export interface CreateSqliteExecutorDbOptions<TTables extends FumaTables = FumaTables> {
  readonly tables: TTables;
  readonly namespace: string;
  readonly version?: string;
  readonly path: string;
}

export const createSqliteExecutorDb = async <const TTables extends FumaTables>(
  options: CreateSqliteExecutorDbOptions<TTables>,
): Promise<SelfHostDbHandle<TTables>> => {
  const version = options.version ?? SELF_HOST_SCHEMA_VERSION;
  if (options.path !== ":memory:") {
    mkdirSync(dirname(options.path), { recursive: true });
  }

  const url = toLibsqlFileUrl(options.path);
  const client = createClient({ url });
  // PER-CONNECTION PRAGMAs: libSQL gives drizzle and Better Auth SEPARATE
  // connections to this file (no single shared handle), so these must be set on
  // this connection here and again on Better Auth's dialect connection. WAL is a
  // file-level mode once any connection enables it; foreign_keys is strictly
  // per-connection and MUST be re-set on each.
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA journal_mode = WAL");
  // Survive concurrent writes from the multi-user HTTP server, and trade
  // fsync-per-commit for fsync-per-checkpoint (durable under WAL).
  await client.execute("PRAGMA busy_timeout = 5000");
  await client.execute("PRAGMA synchronous = NORMAL");

  const schema = createDrizzleRuntimeSchemaFromTables({
    tables: options.tables,
    namespace: options.namespace,
    version,
    provider: "sqlite",
  });
  const drizzleDb = drizzle({ client, schema });

  await ensureDrizzleRuntimeSchemaFromTables(drizzleDb, {
    tables: options.tables,
    namespace: options.namespace,
    version,
    provider: "sqlite",
  });

  const { db, fuma } = createExecutorFumaDb(drizzleDb, {
    tables: options.tables,
    namespace: options.namespace,
    version,
    provider: "sqlite",
  });

  return {
    db,
    fuma,
    drizzle: drizzleDb,
    client,
    url,
    close: async () => {
      client.close();
    },
  };
};

// ---------------------------------------------------------------------------
// Long-lived DB layer. Built once at boot; the connection lives for the
// process. The per-request executor (execution.ts) reuses this handle's `db`
// and only varies the scope stack — so "build once, rebind scope per request"
// is cheap.
// ---------------------------------------------------------------------------

export class SelfHostDb extends Context.Service<SelfHostDb, SelfHostDbHandle>()(
  "@executor-js/host-selfhost/SelfHostDb",
) {}

export interface SelfHostDbLayerOptions {
  readonly path: string;
  readonly namespace?: string;
  readonly version?: string;
}

/**
 * Open the self-host DB with the full plugin table set. Used both by the layer
 * and by the composition root (which needs the raw handle eagerly so Better
 * Auth can open its own libSQL connection to the same `file:` URL).
 */
export const createSelfHostDb = (options: SelfHostDbLayerOptions): Promise<SelfHostDbHandle> =>
  createSqliteExecutorDb({
    tables: collectTables(),
    namespace: options.namespace ?? SELF_HOST_NAMESPACE,
    version: options.version ?? SELF_HOST_SCHEMA_VERSION,
    path: options.path,
  });

// Shared DbProvider seam (P2a). The self-host handle keeps its libSQL driver,
// WAL/busy_timeout PRAGMAs, and the idempotent
// `ensureDrizzleRuntimeSchemaFromTables` bring-up; this just re-exposes the
// already-built long-lived handle under the shared `DbProvider` tag so the
// future shared `makeScopedExecutor` (P3) reads from one injection point. The
// release is owned by `SelfHostDb`, so this projection does not re-close.
export const SelfHostDbProvider: Layer.Layer<DbProvider, never, SelfHostDb> = Layer.effect(
  DbProvider,
)(
  Effect.map(
    SelfHostDb.asEffect(),
    (handle): ExecutorDbHandle => ({
      db: handle.db,
      fuma: handle.fuma,
      close: handle.close,
    }),
  ),
);
