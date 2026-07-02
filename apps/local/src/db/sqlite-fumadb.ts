import { type Client } from "@libsql/client";
import { Layer } from "effect";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { type FumaDB } from "@executor-js/fumadb";
import {
  createDrizzleRuntimeSchemaFromTables,
  ensureDrizzleRuntimeSchemaFromTables,
} from "@executor-js/fumadb/adapters/drizzle";
import { type schema as fumaSchema, type RelationsMap } from "@executor-js/fumadb/schema";

import { createExecutorFumaDb, DbProvider, type ExecutorDbHandle } from "@executor-js/api/server";
import type { FumaDb, FumaTables } from "@executor-js/sdk";

import { openLocalLibsql } from "./libsql";

type SqliteFumaSchema<TTables extends FumaTables> = ReturnType<
  typeof fumaSchema<string, TTables, RelationsMap<TTables>>
>;

export interface SqliteFumaDb<TTables extends FumaTables = FumaTables> {
  readonly db: FumaDb<SqliteFumaSchema<TTables>>;
  readonly fuma: FumaDB<SqliteFumaSchema<TTables>[]>;
  readonly drizzle: LibSQLDatabase<Record<string, unknown>>;
  readonly client: Client;
  readonly close: () => Promise<void>;
}

export interface CreateSqliteFumaDbOptions<TTables extends FumaTables = FumaTables> {
  readonly tables: TTables;
  readonly namespace: string;
  readonly version?: string;
  readonly path: string;
}

export const createSqliteFumaDb = async <const TTables extends FumaTables>(
  options: CreateSqliteFumaDbOptions<TTables>,
): Promise<SqliteFumaDb<TTables>> => {
  const version = options.version ?? "1.0.0";
  // libSQL opens a connection (not a shared in-process handle), so the
  // foreign_keys + WAL PRAGMAs are applied on this connection inside
  // openLocalLibsql.
  const client = await openLocalLibsql(options.path);

  const schema = createDrizzleRuntimeSchemaFromTables({
    tables: options.tables,
    namespace: options.namespace,
    version,
    provider: "sqlite",
  });
  const drizzleDb = drizzle({ client, schema });

  // CREATE TABLE IF NOT EXISTS for fresh files, plus ALTER TABLE ADD COLUMN for
  // every nullable column the running schema declares — so files created by an
  // earlier baseline gain new columns on boot instead of 500ing on first query.
  // This is the same bring-up the self-host and Cloudflare hosts run; keeping
  // local on it stops per-column drift between hosts. Idempotent.
  await ensureDrizzleRuntimeSchemaFromTables(drizzleDb, {
    tables: options.tables,
    namespace: options.namespace,
    version,
    provider: "sqlite",
  });

  // Defensive column adds for libSQL files created by earlier v2 baselines.
  // The generic bring-up above already evolves every nullable column the live
  // schema declares, so these are mostly redundant now; they are kept as an
  // explicit safety net and to cover any column the schema no longer declares.
  // Idempotent.
  const connectionColumns = await client.execute("PRAGMA table_info('connection')");
  if (
    connectionColumns.rows.length > 0 &&
    !connectionColumns.rows.some((column) => column["name"] === "oauth_client_owner")
  ) {
    await client.execute("ALTER TABLE connection ADD COLUMN oauth_client_owner TEXT");
  }
  if (
    connectionColumns.rows.length > 0 &&
    !connectionColumns.rows.some((column) => column["name"] === "identity_override")
  ) {
    await client.execute("ALTER TABLE connection ADD COLUMN identity_override TEXT");
  }

  const oauthClientColumns = await client.execute("PRAGMA table_info('oauth_client')");
  if (
    oauthClientColumns.rows.length > 0 &&
    !oauthClientColumns.rows.some((column) => column["name"] === "origin_kind")
  ) {
    await client.execute("ALTER TABLE oauth_client ADD COLUMN origin_kind TEXT");
  }
  if (
    oauthClientColumns.rows.length > 0 &&
    !oauthClientColumns.rows.some((column) => column["name"] === "origin_integration")
  ) {
    await client.execute("ALTER TABLE oauth_client ADD COLUMN origin_integration TEXT");
  }

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
    close: async () => {
      client.close();
    },
  };
};

// Shared DbProvider seam (P2a). Local builds its libSQL handle once at boot
// (driver-open + WAL PRAGMA + the SQL-loop schema bring-up above stay here) and
// then re-exposes it under the shared `DbProvider` tag. The handle's lifecycle
// is owned by the caller's acquireRelease, so this projection's `close` is a
// no-op to avoid double-closing the connection.
export const localDbProviderLayer = (handle: SqliteFumaDb): Layer.Layer<DbProvider> =>
  Layer.succeed(DbProvider)({
    db: handle.db,
    fuma: handle.fuma,
    close: async () => {},
  } satisfies ExecutorDbHandle);
