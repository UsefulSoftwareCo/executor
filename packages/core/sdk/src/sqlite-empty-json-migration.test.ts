import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { withQueryContext } from "@executor-js/fumadb/query";

import { collectTables } from "./executor";
import { createSqliteTestFumaDb, type SqliteTestFumaDb } from "./sqlite-test-db";
import {
  NULLABLE_JSON_COLUMNS,
  emptyJsonSqliteMigration,
  runSqliteEmptyJsonMigration,
} from "./sqlite-empty-json-migration";

// A `json` column is stored on SQLite as TEXT and read back with `JSON.parse`.
// Databases carried forward from before the FumaDB cutover can hold `''` in
// nullable `json` columns, and `JSON.parse('')` throws on the ROW mapper, so
// one such row takes down the whole `findMany`.
//
// That is issue #2092: `connection.credential_write` held `''`, so
// `connections.list` threw and every toolkit MCP endpoint failed `initialize`.

const TENANT = "t1";
const SUBJECT = "user_a";
const CREDENTIAL_WRITE = { runtimeId: "runtime_1", attemptId: "attempt_1" };

const withDb = <A>(body: (db: SqliteTestFumaDb) => Promise<A>): Promise<A> =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() })),
      (db) => Effect.promise(() => body(db)),
      (db) => Effect.promise(() => db.close()),
    ),
  );

const seconds = (ms: number) => Math.floor(ms / 1000);

/** Insert a connection row with `credential_write` and `last_health` bound as
 *  raw values, so the test controls exactly what the legacy build left behind. */
const insertConnection = (
  db: SqliteTestFumaDb,
  row: {
    readonly rowId: string;
    readonly name: string;
    readonly credentialWrite: string | null;
    readonly lastHealth?: string | null;
  },
): Promise<unknown> =>
  db.client.execute({
    sql: `INSERT INTO connection
      (row_id, tenant, owner, subject, integration, name, template, provider, item_ids,
       credential_write, last_health, created_at, updated_at)
      VALUES (?, ?, 'user', ?, 'acme', ?, 'oauth2', 'file', ?, ?, ?, ?, ?)`,
    args: [
      row.rowId,
      TENANT,
      SUBJECT,
      row.name,
      JSON.stringify({ token: "item_1" }),
      row.credentialWrite,
      row.lastHealth ?? null,
      seconds(Date.now()),
      seconds(Date.now()),
    ],
  });

describe("legacy empty json column migration", () => {
  it.effect("reproduces the connection read failure on a legacy empty string", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        await insertConnection(db, { rowId: "c_legacy", name: "legacy", credentialWrite: "" });

        const scoped = withQueryContext(db.db, { tenant: TENANT, subject: SUBJECT });
        await expect(scoped.findMany("connection", {})).rejects.toThrow(/JSON/);
      }),
    ),
  );

  it.effect("rewrites empty strings to NULL so connections read again", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        await insertConnection(db, {
          rowId: "c_legacy",
          name: "legacy",
          credentialWrite: "",
          lastHealth: "",
        });
        await insertConnection(db, {
          rowId: "c_healthy",
          name: "healthy",
          credentialWrite: JSON.stringify(CREDENTIAL_WRITE),
        });
        await insertConnection(db, { rowId: "c_null", name: "null", credentialWrite: null });

        const rewritten = await Effect.runPromise(runSqliteEmptyJsonMigration(db.client));
        expect(rewritten).toBe(2);

        const scoped = withQueryContext(db.db, { tenant: TENANT, subject: SUBJECT });
        const rows = await scoped.findMany("connection", {});
        expect(
          rows.map((row) => [row.name, row.credential_write ?? null, row.last_health ?? null]),
        ).toEqual([
          ["healthy", CREDENTIAL_WRITE, null],
          ["legacy", null, null],
          ["null", null, null],
        ]);
      }),
    ),
  );

  it.effect("is idempotent", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        await insertConnection(db, { rowId: "c_legacy", name: "legacy", credentialWrite: "" });

        expect(await Effect.runPromise(runSqliteEmptyJsonMigration(db.client))).toBe(1);
        expect(await Effect.runPromise(runSqliteEmptyJsonMigration(db.client))).toBe(0);

        const scoped = withQueryContext(db.db, { tenant: TENANT, subject: SUBJECT });
        const rows = await scoped.findMany("connection", {});
        expect(rows.map((row) => row.credential_write ?? null)).toEqual([null]);
      }),
    ),
  );

  it.effect("leaves NOT NULL json columns alone", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        await insertConnection(db, { rowId: "c1", name: "c1", credentialWrite: null });
        await db.client.execute(`UPDATE connection SET item_ids = '' WHERE row_id = 'c1'`);

        expect(await Effect.runPromise(runSqliteEmptyJsonMigration(db.client))).toBe(0);

        const result = await db.client.execute(
          "SELECT item_ids FROM connection WHERE row_id = 'c1'",
        );
        expect(result.rows[0]?.["item_ids"]).toBe("");
      }),
    ),
  );

  it("covers every nullable json column the core schema declares", () => {
    const tables = collectTables() as Record<string, { readonly columns: Record<string, unknown> }>;
    const declared: string[] = [];
    for (const [tableName, table] of Object.entries(tables)) {
      for (const [columnName, column] of Object.entries(table.columns)) {
        const { type, isNullable } = column as {
          readonly type?: string;
          readonly isNullable?: boolean;
        };
        if (type === "json" && isNullable) declared.push(`${tableName}.${columnName}`);
      }
    }
    const covered = NULLABLE_JSON_COLUMNS.map((entry) => `${entry.table}.${entry.column}`);
    expect(covered).toContain("connection.credential_write");
    expect(covered).toContain("connection.last_health");
    expect(covered).toContain("connection.provider_state");
    expect(covered).not.toContain("connection.item_ids");
    expect(covered.slice().sort()).toEqual(declared.sort());
  });

  it("is registered under a stable, date-prefixed name", () => {
    expect(emptyJsonSqliteMigration.name).toBe("2026-09-24-empty-json-columns");
  });
});
