// ---------------------------------------------------------------------------
// libSQL boot migration: rewrite `bigint` columns that an earlier build left in
// SQLite's INTEGER storage class (issue #1771).
//
// A `bigint` column is stored on SQLite as a BLOB holding the value's decimal
// digits — that is what drizzle's `blob({ mode: "bigint" })` writes, and its
// row mapper reads the blob back with `Buffer.from(...)`. Before these columns
// carried the `bigint` flag they were plain numbers, which SQLite kept in the
// INTEGER storage class. SQLite does not rewrite existing rows when a column's
// declared type changes, so an install written by that build still holds
// integers today.
//
// Reading one back now reaches `Buffer.from(<number>)`, which throws
// `ERR_INVALID_ARG_TYPE`. The throw is in the ROW mapper, so it fails the whole
// `findMany` rather than one field: on a database whose `connection` rows
// carried an OAuth `expires_at` from that era, EVERY catalog read threw and the
// MCP gateway served an empty tool list even though the integrations were all
// still saved.
//
// The rewrite is deliberately narrow. It touches only the columns the schema
// declares `bigint`, and within them only values whose storage class is
// `integer` or `real` — the shapes the mapper cannot read. Values already
// stored as BLOB or TEXT (TEXT is what the v1→v2 migration writes, and the
// mapper reads it fine) are left exactly as they are. `CAST(x AS BLOB)`
// converts through TEXT, so the stored bytes end up identical to what the ORM
// writes today. Idempotent: after a run no column is in a numeric storage
// class, so a second run updates nothing.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import { coreSchema } from "./core-schema";
import {
  DataMigrationError,
  type SqliteDataMigration,
  type SqliteDataMigrationClient,
} from "./sqlite-data-migrations";

const MIGRATION_NAME = "2026-08-28-bigint-storage-class";

export interface BigintStorageClassColumn {
  /** SQL table name. */
  readonly table: string;
  /** SQL column name. */
  readonly column: string;
}

/**
 * Every `bigint` column in the core schema, by SQL name.
 *
 * Derived from the schema rather than hand-listed so a column added later can
 * never be silently missed. Scanning a column that never held an integer is a
 * no-op, so over-coverage costs one indexed-free table scan at first boot.
 */
export const LEGACY_BIGINT_STORAGE_CLASS_COLUMNS: readonly BigintStorageClassColumn[] =
  Object.values(coreSchema).flatMap((table) =>
    Object.values(table.columns)
      .filter((column) => column.type === "bigint")
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
 * Convert legacy INTEGER/REAL values in the schema's `bigint` columns to the
 * blob representation the ORM reads.
 *
 * Returns the number of rows rewritten. Wrapped in BEGIN…COMMIT so a mid-run
 * failure leaves the database untouched and the (unstamped) migration re-runs
 * cleanly on the next boot.
 */
export const runSqliteBigintStorageClassMigration = (
  client: SqliteDataMigrationClient,
): Effect.Effect<number, DataMigrationError> =>
  Effect.gen(function* () {
    const pending: { readonly sql: string; readonly count: number }[] = [];

    for (const target of LEGACY_BIGINT_STORAGE_CLASS_COLUMNS) {
      const table = yield* quoteIdentifier(target.table);
      const column = yield* quoteIdentifier(target.column);
      if (!(yield* hasColumn(client, target.table, table, target.column))) continue;

      // `typeof()` reports the STORAGE class, which is what the mapper trips
      // over — the declared column type is irrelevant to SQLite here.
      const predicate = `typeof(${column}) IN ('integer', 'real')`;

      const counted = yield* execute(
        client,
        `SELECT COUNT(*) AS n FROM ${table} WHERE ${predicate}`,
      );
      const count = Number(counted.rows[0]?.["n"] ?? 0);
      if (count === 0) continue;

      pending.push({
        sql: `UPDATE ${table} SET ${column} = CAST(CAST(${column} AS INTEGER) AS BLOB) WHERE ${predicate}`,
        count,
      });
    }

    if (pending.length === 0) return 0;

    const applyAll = Effect.gen(function* () {
      let converted = 0;
      for (const statement of pending) {
        yield* execute(client, statement.sql);
        converted += statement.count;
      }
      yield* execute(client, "COMMIT");
      return converted;
    });

    yield* execute(client, "BEGIN");
    return yield* applyAll.pipe(
      Effect.tapError(() => execute(client, "ROLLBACK").pipe(Effect.ignore)),
      // `tapError` only fires on a typed failure, not on fiber interruption
      // (e.g. the boot sequence timing out mid-migration) — so without this an
      // interrupted run can leave the transaction open. Never fires on success:
      // COMMIT has already run by then.
      Effect.onInterrupt(() => execute(client, "ROLLBACK").pipe(Effect.ignore)),
    );
  });

/** Registry entry for the SQLite hosts' boot-time data-migration ledger. */
export const bigintStorageClassSqliteMigration: SqliteDataMigration = {
  name: MIGRATION_NAME,
  run: (client) => runSqliteBigintStorageClassMigration(client).pipe(Effect.asVoid),
};
