// ---------------------------------------------------------------------------
// libSQL boot migration: rewrite empty strings in nullable `json` columns to
// NULL (issue #2092).
//
// A `json` column is stored on SQLite as TEXT, and its row mapper reads the
// value back with `JSON.parse`. Databases carried forward from builds before
// the FumaDB cutover can hold `''` where the current schema expects NULL (seen
// in `connection.credential_write`). `JSON.parse('')` throws, and because the
// throw is in the ROW mapper it fails the whole `findMany`: one such row made
// `connections.list` throw, so every `/mcp/toolkits/<slug>` session failed on
// `initialize`.
//
// The rewrite is deliberately narrow. It touches only the columns the schema
// declares `json` AND nullable, and within them only values that are exactly
// the empty string. NULL is what the ORM writes for "no value" in these
// columns, so the repaired rows read back the way a current build would have
// written them. NOT NULL `json` columns are left alone: an empty string there
// has no faithful replacement. Idempotent: after a run no nullable `json`
// column holds `''`, so a second run updates nothing.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import { coreSchema } from "./core-schema";
import {
  DataMigrationError,
  type SqliteDataMigration,
  type SqliteDataMigrationClient,
} from "./sqlite-data-migrations";

const MIGRATION_NAME = "2026-09-24-empty-json-columns";

export interface EmptyJsonColumn {
  /** SQL table name. */
  readonly table: string;
  /** SQL column name. */
  readonly column: string;
}

/**
 * Every nullable `json` column in the core schema, by SQL name.
 *
 * Derived from the schema rather than hand-listed so a column added later can
 * never be silently missed.
 */
export const NULLABLE_JSON_COLUMNS: readonly EmptyJsonColumn[] = Object.values(coreSchema).flatMap(
  (table) =>
    Object.values(table.columns)
      .filter((column) => column.type === "json" && column.isNullable)
      .map((column) => ({ table: table.names.sql, column: column.names.sql })),
);

const execute = (
  client: SqliteDataMigrationClient,
  stmt: string | { readonly sql: string; readonly args: readonly unknown[] },
) =>
  Effect.tryPromise({
    try: () => client.execute(stmt),
    catch: (cause) => new DataMigrationError({ migration: MIGRATION_NAME, cause }),
  });

/** SQLite identifiers are quoted, not parameterized. Every name here comes from
 *  the compiled-in schema, so this always matches; anything else is refused
 *  rather than interpolated. */
const quoteIdentifier = (name: string): Effect.Effect<string, DataMigrationError> =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    ? Effect.succeed(`"${name}"`)
    : Effect.fail(
        new DataMigrationError({
          migration: MIGRATION_NAME,
          cause: `Refusing to interpolate SQL identifier: ${name}`,
        }),
      );

const hasColumn = (
  client: SqliteDataMigrationClient,
  table: string,
  quotedTable: string,
  column: string,
): Effect.Effect<boolean, DataMigrationError> =>
  execute(client, {
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    args: [table],
  }).pipe(
    Effect.flatMap((tables) =>
      tables.rows.length === 0
        ? Effect.succeed(false)
        : execute(client, `PRAGMA table_info(${quotedTable})`).pipe(
            Effect.map((info) => info.rows.some((row) => row["name"] === column)),
          ),
    ),
  );

/**
 * Set empty-string values in the schema's nullable `json` columns to NULL.
 *
 * Returns the number of values rewritten. Wrapped in BEGIN…COMMIT so a mid-run
 * failure leaves the database untouched and the (unstamped) migration re-runs
 * cleanly on the next boot.
 */
export const runSqliteEmptyJsonMigration = (
  client: SqliteDataMigrationClient,
): Effect.Effect<number, DataMigrationError> =>
  Effect.gen(function* () {
    const pending: { readonly sql: string; readonly count: number }[] = [];

    for (const target of NULLABLE_JSON_COLUMNS) {
      const table = yield* quoteIdentifier(target.table);
      const column = yield* quoteIdentifier(target.column);
      if (!(yield* hasColumn(client, target.table, table, target.column))) continue;

      const predicate = `${column} = ''`;

      const counted = yield* execute(
        client,
        `SELECT COUNT(*) AS n FROM ${table} WHERE ${predicate}`,
      );
      const count = Number(counted.rows[0]?.["n"] ?? 0);
      if (count === 0) continue;

      pending.push({
        sql: `UPDATE ${table} SET ${column} = NULL WHERE ${predicate}`,
        count,
      });
    }

    if (pending.length === 0) return 0;

    const applyAll = Effect.gen(function* () {
      let rewritten = 0;
      for (const statement of pending) {
        yield* execute(client, statement.sql);
        rewritten += statement.count;
      }
      yield* execute(client, "COMMIT");
      return rewritten;
    });

    yield* execute(client, "BEGIN");
    return yield* applyAll.pipe(
      Effect.tapError(() => execute(client, "ROLLBACK").pipe(Effect.ignore)),
      Effect.onInterrupt(() => execute(client, "ROLLBACK").pipe(Effect.ignore)),
    );
  });

/** Registry entry for the SQLite hosts' boot-time data-migration ledger. */
export const emptyJsonSqliteMigration: SqliteDataMigration = {
  name: MIGRATION_NAME,
  run: (client) => runSqliteEmptyJsonMigration(client).pipe(Effect.asVoid),
};
