import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { withQueryContext } from "@executor-js/fumadb/query";

import { collectTables } from "./executor";
import { createSqliteTestFumaDb, type SqliteTestFumaDb } from "./sqlite-test-db";
import {
  LEGACY_BIGINT_STORAGE_CLASS_COLUMNS,
  bigintStorageClassSqliteMigration,
  runSqliteBigintStorageClassMigration,
} from "./sqlite-bigint-storage-class-migration";

// A `bigint` column is stored on SQLite as a blob holding the decimal digits
// (drizzle's `blob({ mode: "bigint" })`). Before the columns below carried the
// `bigint` flag they were plain numbers, so SQLite kept them in the INTEGER
// storage class — and an install written by that build still holds integers
// today. Reading one back through the bigint mapper reaches
// `Buffer.from(<number>)`, which throws `ERR_INVALID_ARG_TYPE`, and because the
// throw is on the ROW mapper it takes down the whole `findMany`, not one field.
//
// That is issue #1771: `connection.expires_at` held an epoch-millis integer, so
// every catalog read threw and the MCP gateway served an empty tool list even
// though the integrations were still saved.

const TENANT = "t1";
const SUBJECT = "user_a";
const LEGACY_EXPIRES_AT = 1787321623456;
const HEALTHY_EXPIRES_AT = 1787321699999;

const withDb = <A>(body: (db: SqliteTestFumaDb) => Promise<A>): Promise<A> =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() })),
      (db) => Effect.promise(() => body(db)),
      (db) => Effect.promise(() => db.close()),
    ),
  );

const seconds = (ms: number) => Math.floor(ms / 1000);

/** Insert a connection row whose `expires_at` is set by a raw SQL expression,
 *  so the test controls its SQLite storage class exactly: an integer literal
 *  lands as INTEGER — what a build that declared the column `integer` wrote —
 *  while `CAST(... AS BLOB)` lands as BLOB, what the ORM writes today. A bound
 *  JS number would land as REAL under the column's current BLOB affinity, which
 *  is a different (also broken) shape. */
const insertConnection = (
  db: SqliteTestFumaDb,
  row: { readonly rowId: string; readonly name: string; readonly expiresAtSql: string },
): Promise<unknown> =>
  db.client.execute({
    sql: `INSERT INTO connection
      (row_id, tenant, owner, subject, integration, name, template, provider, item_ids,
       expires_at, created_at, updated_at)
      VALUES (?, ?, 'user', ?, 'acme', ?, 'oauth2', 'file', ?, ${row.expiresAtSql}, ?, ?)`,
    args: [
      row.rowId,
      TENANT,
      SUBJECT,
      row.name,
      JSON.stringify({ token: "item_1" }),
      seconds(Date.now()),
      seconds(Date.now()),
    ],
  });

/** The legacy shape: a bare integer literal, stored in the INTEGER class. */
const legacyInteger = String(LEGACY_EXPIRES_AT);
/** The current shape: the decimal digits as bytes. */
const currentBlob = `CAST('${HEALTHY_EXPIRES_AT}' AS BLOB)`;

const storageClassOf = async (db: SqliteTestFumaDb, rowId: string): Promise<string> => {
  const result = await db.client.execute({
    sql: "SELECT typeof(expires_at) AS kind FROM connection WHERE row_id = ?",
    args: [rowId],
  });
  return String(result.rows[0]?.["kind"]);
};

describe("legacy bigint storage class migration", () => {
  it.effect("reproduces the catalog read failure on a legacy integer row", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        await insertConnection(db, {
          rowId: "c_legacy",
          name: "legacy",
          expiresAtSql: legacyInteger,
        });
        expect(await storageClassOf(db, "c_legacy")).toBe("integer");

        const scoped = withQueryContext(db.db, { tenant: TENANT, subject: SUBJECT });
        // Not "returns a bad value" — the read THROWS, which is why the gateway
        // lost every saved integration rather than one field of one row.
        await expect(scoped.findMany("connection", {})).rejects.toThrow(/type number/);
      }),
    ),
  );

  it.effect("converts legacy integers so the catalog reads again", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        await insertConnection(db, {
          rowId: "c_legacy",
          name: "legacy",
          expiresAtSql: legacyInteger,
        });
        await insertConnection(db, {
          rowId: "c_healthy",
          name: "healthy",
          expiresAtSql: currentBlob,
        });
        await insertConnection(db, { rowId: "c_null", name: "null", expiresAtSql: "NULL" });

        const converted = await Effect.runPromise(runSqliteBigintStorageClassMigration(db.client));
        expect(converted).toBe(1);

        expect(await storageClassOf(db, "c_legacy")).toBe("blob");
        expect(await storageClassOf(db, "c_healthy")).toBe("blob");
        expect(await storageClassOf(db, "c_null")).toBe("null");

        const scoped = withQueryContext(db.db, { tenant: TENANT, subject: SUBJECT });
        const rows = await scoped.findMany("connection", {});
        expect(
          rows.map((row) => [row.name, row.expires_at == null ? null : Number(row.expires_at)]),
        ).toEqual([
          ["healthy", HEALTHY_EXPIRES_AT],
          ["legacy", LEGACY_EXPIRES_AT],
          ["null", null],
        ]);
      }),
    ),
  );

  it.effect("is idempotent", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        await insertConnection(db, {
          rowId: "c_legacy",
          name: "legacy",
          expiresAtSql: legacyInteger,
        });

        expect(await Effect.runPromise(runSqliteBigintStorageClassMigration(db.client))).toBe(1);
        expect(await Effect.runPromise(runSqliteBigintStorageClassMigration(db.client))).toBe(0);

        const scoped = withQueryContext(db.db, { tenant: TENANT, subject: SUBJECT });
        const rows = await scoped.findMany("connection", {});
        expect(rows.map((row) => Number(row.expires_at))).toEqual([LEGACY_EXPIRES_AT]);
      }),
    ),
  );

  it.effect("converts every bigint column that predates the flag", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        // `oauth_session.expires_at` was re-typed in the same change, and
        // `connection.tools_synced_at` / `integration.config_revised_at` /
        // `subject.last_seen_at` share the representation.
        await db.client.execute({
          sql: `INSERT INTO integration
            (row_id, tenant, slug, plugin_id, description, config_revised_at, created_at, updated_at)
            VALUES ('i1', ?, 'acme', 'openapi', '', ${legacyInteger}, ?, ?)`,
          args: [TENANT, seconds(Date.now()), seconds(Date.now())],
        });
        await insertConnection(db, { rowId: "c1", name: "c1", expiresAtSql: "NULL" });
        await db.client.execute(
          `UPDATE connection SET tools_synced_at = ${legacyInteger} WHERE row_id = 'c1'`,
        );

        expect(await Effect.runPromise(runSqliteBigintStorageClassMigration(db.client))).toBe(2);

        const scoped = withQueryContext(db.db, { tenant: TENANT, subject: SUBJECT });
        const integrations = await scoped.findMany("integration", {});
        expect(integrations.map((row) => Number(row.config_revised_at))).toEqual([
          LEGACY_EXPIRES_AT,
        ]);
        const connections = await scoped.findMany("connection", {});
        expect(connections.map((row) => Number(row.tools_synced_at))).toEqual([LEGACY_EXPIRES_AT]);
      }),
    ),
  );

  it("covers every bigint column the core schema declares", () => {
    const tables = collectTables() as Record<string, { readonly columns: Record<string, unknown> }>;
    const declared: string[] = [];
    for (const [tableName, table] of Object.entries(tables)) {
      for (const [columnName, column] of Object.entries(table.columns)) {
        if ((column as { readonly type?: string }).type === "bigint") {
          declared.push(`${tableName}.${columnName}`);
        }
      }
    }
    const covered = LEGACY_BIGINT_STORAGE_CLASS_COLUMNS.map(
      (entry) => `${entry.table}.${entry.column}`,
    );
    expect(covered.slice().sort()).toEqual(declared.sort());
  });

  it("is registered under a stable, date-prefixed name", () => {
    expect(bigintStorageClassSqliteMigration.name).toBe("2026-08-28-bigint-storage-class");
  });
});
