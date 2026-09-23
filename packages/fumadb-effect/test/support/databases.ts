/**
 * Real databases for tests. Start them with `bun run db:up` (docker compose).
 *
 * Environment:
 * - `FUMADB_TEST_PROVIDERS`: comma-separated subset of providers (default: all five).
 * - `FUMADB_TEST_DATABASE`: database name, so concurrent test runs do not collide (default `fumadb_test`).
 */
import { MssqlClient } from "@effect/sql-mssql";
import { MysqlClient } from "@effect/sql-mysql2";
import { PgClient } from "@effect/sql-pg";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { type Config, Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isProvider,
  type Provider,
  providers as allProviders,
} from "../../src/contracts/provider.ts";

export const databaseName = process.env["FUMADB_TEST_DATABASE"] ?? "fumadb_test";

const requested = process.env["FUMADB_TEST_PROVIDERS"];
export const providers: ReadonlyArray<Provider> =
  requested === undefined
    ? allProviders
    : requested
        .split(",")
        .map((p) => p.trim())
        .filter(isProvider);

const sqliteDirectory = path.join(os.tmpdir(), "fumadb-effect-tests");
fs.mkdirSync(sqliteDirectory, { recursive: true });
export const sqlitePath = path.join(sqliteDirectory, `${databaseName}.sqlite`);

/** A `SqlClient` layer for one provider. */
/** Failures of connecting to a test database. */
export type ConnectError = SqlError | Config.ConfigError;

export const layerFor = (provider: Provider): Layer.Layer<SqlClient.SqlClient, ConnectError> => {
  switch (provider) {
    case "postgresql":
      return PgClient.layer({
        url: Redacted.make(`postgresql://user:password@localhost:5434/${databaseName}`),
      });
    case "cockroachdb":
      return PgClient.layer({
        url: Redacted.make(
          `postgresql://root:password@localhost:26257/${databaseName}?sslmode=disable`,
        ),
      });
    case "mysql":
      return MysqlClient.layer({
        url: Redacted.make(`mysql://root:password@localhost:3308/${databaseName}`),
      });
    case "mssql":
      return MssqlClient.layer({
        server: "localhost",
        port: 1433,
        database: databaseName,
        username: "sa",
        password: Redacted.make("Password1234!"),
        encrypt: false,
        trustServer: true,
      });
    case "sqlite":
      return SqliteClient.layer({ filename: sqlitePath });
  }
};

/** Drop every user table in the connected database. */
export const resetDatabase = (
  provider: Provider,
): Effect.Effect<void, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    switch (provider) {
      case "mysql": {
        yield* sql.unsafe("SET FOREIGN_KEY_CHECKS = 0");
        const tables = yield* sql<{ TABLE_NAME: string }>`
          SELECT TABLE_NAME FROM information_schema.tables
          WHERE TABLE_SCHEMA = ${databaseName} AND TABLE_TYPE = 'BASE TABLE'`;
        for (const t of tables) yield* sql.unsafe(`DROP TABLE IF EXISTS \`${t.TABLE_NAME}\``);
        yield* sql.unsafe("SET FOREIGN_KEY_CHECKS = 1");
        return;
      }
      case "sqlite": {
        const tables = yield* sql<{ name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`;
        yield* sql.unsafe("PRAGMA foreign_keys = OFF");
        for (const t of tables) yield* sql.unsafe(`DROP TABLE IF EXISTS "${t.name}"`);
        yield* sql.unsafe("PRAGMA foreign_keys = ON");
        return;
      }
      case "postgresql":
      case "cockroachdb": {
        const tables = yield* sql<{ table_schema: string; table_name: string }>`
          SELECT table_schema, table_name FROM information_schema.tables
          WHERE table_type = 'BASE TABLE'
            AND table_schema NOT IN ('pg_catalog', 'information_schema', 'crdb_internal', 'pg_extension')`;
        for (const t of tables)
          yield* sql.unsafe(`DROP TABLE IF EXISTS "${t.table_schema}"."${t.table_name}" CASCADE`);
        return;
      }
      case "mssql": {
        const constraints = yield* sql<{ table_name: string; constraint_name: string }>`
          SELECT o.name AS table_name, fk.name AS constraint_name
          FROM sys.foreign_keys fk INNER JOIN sys.objects o ON fk.parent_object_id = o.object_id`;
        for (const c of constraints)
          yield* sql.unsafe(`ALTER TABLE [${c.table_name}] DROP CONSTRAINT [${c.constraint_name}]`);
        const tables = yield* sql<{ table_name: string }>`
          SELECT table_name FROM information_schema.tables
          WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('sys', 'INFORMATION_SCHEMA')`;
        for (const t of tables) yield* sql.unsafe(`DROP TABLE [${t.table_name}]`);
        return;
      }
    }
  });

/** Run an effect against one provider with a fresh, empty database. */
export const withProvider = <A, E>(
  provider: Provider,
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
): Effect.Effect<A, E | ConnectError> =>
  Effect.gen(function* () {
    yield* resetDatabase(provider);
    return yield* effect;
  }).pipe(Effect.provide(layerFor(provider)), Effect.scoped);
