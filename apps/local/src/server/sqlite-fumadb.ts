import { type Client } from "@libsql/client";
import { Layer } from "effect";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { type FumaDB } from "fumadb";
import {
  createDrizzleRuntimeSchemaFromTables,
  createDrizzleRuntimeSchemaSqlFromTables,
} from "fumadb/adapters/drizzle";
import { type schema as fumaSchema, type RelationsMap } from "fumadb/schema";

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

  for (const statement of createDrizzleRuntimeSchemaSqlFromTables({
    tables: options.tables,
    namespace: options.namespace,
    version,
    provider: "sqlite",
  })) {
    await client.execute(statement);
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
