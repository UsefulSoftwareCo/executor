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
// swapping the `file:` URL for an https Turso URL). Better Auth SHARES this very
// `@libsql/client` (its LibsqlDialect is built with `{ client }`, not a fresh
// `{ url }` connection) — so the PRAGMAs set here cover auth queries too, and
// there is exactly ONE connection and ONE WAL. That sharing is load-bearing: a
// second libSQL connection to the same file unlinks this one's `-wal`/`-shm` on
// open, orphaning executor-core writes onto a deleted inode that vanishes on
// restart (the self-host data-loss bug — see better-auth.ts's header).
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
   * The libSQL client for this handle's `file:` URL. Better Auth's LibsqlDialect
   * is built on THIS client (one shared connection — see better-auth.ts), and
   * the seed reads Better Auth's tables through it too. `url` is retained for
   * callers that still need the `file:` string (diagnostics, edge swap).
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
  // Connection PRAGMAs. This is the ONE libSQL connection for the process —
  // drizzle (executor tables) and Better Auth's LibsqlDialect both run on this
  // same client (see better-auth.ts), so these apply to every query, auth
  // included. WAL is a file-level mode; foreign_keys/busy_timeout/synchronous
  // are connection-level and set once here.
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
