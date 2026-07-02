import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type FumaDB } from "@executor-js/fumadb";
import {
  createDrizzleRuntimeSchemaFromTables,
  createDrizzleRuntimeSchemaSqlFromTables,
} from "@executor-js/fumadb/adapters/drizzle";
import { type schema as fumaSchema, type RelationsMap } from "@executor-js/fumadb/schema";

import { createExecutorFumaDb } from "./executor-fuma-db";
import type { FumaDb, FumaTables } from "./fuma-runtime";

type SqliteTestFumaSchema<TTables extends FumaTables> = ReturnType<
  typeof fumaSchema<string, TTables, RelationsMap<TTables>>
>;

export interface SqliteTestFumaDb<TTables extends FumaTables = FumaTables> {
  readonly db: FumaDb<SqliteTestFumaSchema<TTables>>;
  readonly fuma: FumaDB<SqliteTestFumaSchema<TTables>[]>;
  readonly drizzle: LibSQLDatabase<Record<string, unknown>>;
  readonly client: Client;
  readonly close: () => Promise<void>;
}

export interface CreateSqliteTestFumaDbOptions<TTables extends FumaTables = FumaTables> {
  readonly tables: TTables;
  readonly namespace?: string;
  readonly version?: string;
  readonly path?: string;
}

export const createSqliteTestFumaDb = async <const TTables extends FumaTables>(
  options: CreateSqliteTestFumaDbOptions<TTables>,
): Promise<SqliteTestFumaDb<TTables>> => {
  const version = options.version ?? "1.0.0";
  const namespace = options.namespace ?? "executor_test";
  if (options.path && options.path !== ":memory:") {
    mkdirSync(dirname(options.path), { recursive: true });
  }
  // libSQL `:memory:` is a single connection per client, matching the test's
  // single-handle expectation. foreign_keys is per-connection (no shared
  // handle to inherit it), so set it on this one.
  const url =
    !options.path || options.path === ":memory:" ? ":memory:" : `file:${resolve(options.path)}`;
  const client = createClient({ url });
  await client.execute("PRAGMA foreign_keys = ON");

  const schema = createDrizzleRuntimeSchemaFromTables({
    tables: options.tables,
    namespace,
    version,
    provider: "sqlite",
  });
  const drizzleDb = drizzle({ client, schema });

  for (const statement of createDrizzleRuntimeSchemaSqlFromTables({
    tables: options.tables,
    namespace,
    version,
    provider: "sqlite",
  })) {
    await client.execute(statement);
  }

  const { db, fuma } = createExecutorFumaDb(drizzleDb, {
    tables: options.tables,
    namespace,
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
