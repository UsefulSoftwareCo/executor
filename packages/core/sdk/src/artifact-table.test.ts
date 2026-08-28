import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { withQueryContext } from "@executor-js/fumadb/query";

import { collectTables } from "./executor";
import { createSqliteTestFumaDb, type SqliteTestFumaDb } from "./sqlite-test-db";

// The artifact table is OWNER-scoped: a saved artifact belongs to the subject
// who generated it, and nobody else in the tenant may read it (org-tier
// sharing is a later change that reuses the `owner` column already here).
// Written against the real SQLite bring-up (`createSqliteTestFumaDb` runs the
// same statements the local/self-host/D1 hosts boot with) instead of asserting
// on the table definition object.

const TENANT = "t1";
const SUBJECT = "user_a";
const OTHER_SUBJECT = "user_b";

const withDb = <A>(body: (db: SqliteTestFumaDb) => Promise<A>): Promise<A> =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() })),
      (db) => Effect.promise(() => body(db)),
      (db) => Effect.promise(() => db.close()),
    ),
  );

const insertArtifact = (
  db: SqliteTestFumaDb,
  row: {
    readonly rowId: string;
    readonly tenant: string;
    readonly subject: string;
    readonly id: string;
    readonly title?: string;
  },
): Promise<unknown> =>
  db.client.execute({
    sql: `INSERT INTO artifact (row_id, tenant, owner, subject, id, title, description, code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      row.rowId,
      row.tenant,
      "user",
      row.subject,
      row.id,
      row.title ?? "Dashboard",
      null,
      "export default function App() { return null; }",
      Date.now(),
      Date.now(),
    ],
  });

describe("artifact table", () => {
  it.effect("is created by the runtime schema bring-up", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        const info = await db.client.execute("PRAGMA table_info('artifact')");
        const columns = info.rows.map((row) => String(row["name"]));
        expect(columns).toEqual(
          expect.arrayContaining([
            "row_id",
            "tenant",
            "owner",
            "subject",
            "id",
            "title",
            "description",
            "code",
            "bindings",
            "created_at",
            "updated_at",
          ]),
        );
      }),
    ),
  );

  it.effect("keys one row per (tenant, owner, subject, id)", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        await insertArtifact(db, { rowId: "a1", tenant: TENANT, subject: SUBJECT, id: "art_1" });

        // The same artifact id under a DIFFERENT subject is a different row —
        // ids are only unique within one owner partition.
        await insertArtifact(db, {
          rowId: "a2",
          tenant: TENANT,
          subject: OTHER_SUBJECT,
          id: "art_1",
        });

        await expect(
          insertArtifact(db, { rowId: "a3", tenant: TENANT, subject: SUBJECT, id: "art_1" }),
        ).rejects.toThrow();

        const rows = await db.client.execute("SELECT row_id FROM artifact ORDER BY row_id");
        expect(rows.rows.map((row) => String(row["row_id"]))).toEqual(["a1", "a2"]);
      }),
    ),
  );

  it.effect("hides another subject's artifacts from a bound executor", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        await insertArtifact(db, {
          rowId: "a1",
          tenant: TENANT,
          subject: SUBJECT,
          id: "art_mine",
          title: "Mine",
        });
        await insertArtifact(db, {
          rowId: "a2",
          tenant: TENANT,
          subject: OTHER_SUBJECT,
          id: "art_theirs",
          title: "Theirs",
        });

        const scoped = withQueryContext(db.db, { tenant: TENANT, subject: SUBJECT });
        const visible = await scoped.findMany("artifact", {});
        expect(visible.map((row) => row.id)).toEqual(["art_mine"]);

        const otherScoped = withQueryContext(db.db, { tenant: TENANT, subject: OTHER_SUBJECT });
        const otherVisible = await otherScoped.findMany("artifact", {});
        expect(otherVisible.map((row) => row.id)).toEqual(["art_theirs"]);
      }),
    ),
  );
});
