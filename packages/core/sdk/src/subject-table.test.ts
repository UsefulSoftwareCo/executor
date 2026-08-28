import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { withQueryContext } from "@executor-js/fumadb/query";

import { collectTables } from "./executor";
import { createSqliteTestFumaDb, type SqliteTestFumaDb } from "./sqlite-test-db";

// The subject table has no readers or writers yet (it is populated in a later
// change), so this pins the two properties the schema alone is responsible
// for: the boot bring-up actually creates it, and it is TENANT-scoped rather
// than owner-scoped — any executor bound to the tenant may read it, which is
// what a cross-subject view needs. Written against the real SQLite bring-up
// (`createSqliteTestFumaDb` runs the same statements the local/self-host/D1
// hosts boot with) instead of asserting on the table definition object.

const TENANT = "t1";
const OTHER_TENANT = "t2";

const withDb = <A>(body: (db: SqliteTestFumaDb) => Promise<A>): Promise<A> =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() })),
      (db) => Effect.promise(() => body(db)),
      (db) => Effect.promise(() => db.close()),
    ),
  );

const insertSubject = (
  db: SqliteTestFumaDb,
  row: { readonly rowId: string; readonly tenant: string; readonly externalId: string },
): Promise<unknown> =>
  db.client.execute({
    sql: `INSERT INTO subject (row_id, tenant, external_id, created_at, last_seen_at, status)
      VALUES (?, ?, ?, ?, ?, ?)`,
    args: [row.rowId, row.tenant, row.externalId, Date.now(), null, null],
  });

describe("subject table", () => {
  it.effect("is created by the runtime schema bring-up", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        const info = await db.client.execute("PRAGMA table_info('subject')");
        const columns = info.rows.map((row) => String(row["name"]));
        expect(columns).toEqual(
          expect.arrayContaining([
            "row_id",
            "tenant",
            "external_id",
            "created_at",
            "last_seen_at",
            "status",
          ]),
        );
      }),
    ),
  );

  it.effect("keys one row per (tenant, external_id)", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        await insertSubject(db, { rowId: "s1", tenant: TENANT, externalId: "user_a" });

        // The same principal id under a DIFFERENT tenant is a different row —
        // external ids are only unique within their tenant.
        await insertSubject(db, { rowId: "s2", tenant: OTHER_TENANT, externalId: "user_a" });

        await expect(
          insertSubject(db, { rowId: "s3", tenant: TENANT, externalId: "user_a" }),
        ).rejects.toThrow();

        const rows = await db.client.execute("SELECT row_id FROM subject ORDER BY row_id");
        expect(rows.rows.map((row) => String(row["row_id"]))).toEqual(["s1", "s2"]);
      }),
    ),
  );

  it.effect("tolerates the host sentinel subject id", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        // Local/self-host bind every request to the literal subject "local";
        // nothing may assume external ids are opaque provider identifiers.
        await insertSubject(db, { rowId: "s1", tenant: TENANT, externalId: "local" });
        const rows = await db.client.execute("SELECT external_id FROM subject");
        expect(rows.rows.map((row) => String(row["external_id"]))).toEqual(["local"]);
      }),
    ),
  );

  it.effect("reads only within the bound tenant", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        await insertSubject(db, { rowId: "s1", tenant: TENANT, externalId: "user_a" });
        await insertSubject(db, { rowId: "s2", tenant: OTHER_TENANT, externalId: "user_b" });

        // No `subject` in the context: a pure-org executor still reads the
        // table, which is the whole point of tenant scoping.
        const scoped = withQueryContext(db.db, { tenant: TENANT, subject: null });
        const visible = await scoped.findMany("subject", {});
        expect(visible.map((row) => row.external_id)).toEqual(["user_a"]);
      }),
    ),
  );
});
