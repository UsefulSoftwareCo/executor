import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { withQueryContext } from "@executor-js/fumadb/query";

import { collectTables } from "./executor";
import { createSqliteTestFumaDb, type SqliteTestFumaDb } from "./sqlite-test-db";

// The platform view is `reach: "tenant"` on the owner-policy context: reads
// widen from {this subject + org rows} to {the whole tenant}, and writes do not
// widen at all. These tests pin BOTH halves against the real SQLite bring-up —
// the widening is only useful if the not-widening is airtight.

const TENANT = "t1";
const OTHER_TENANT = "t2";
const SUBJECT_A = "user_a";
const SUBJECT_B = "user_b";

const withDb = <A>(body: (db: SqliteTestFumaDb) => Promise<A>): Promise<A> =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() })),
      (db) => Effect.promise(() => body(db)),
      (db) => Effect.promise(() => db.close()),
    ),
  );

/** Insert a connection row directly, bypassing the policy — these tests are
 *  about what a context may SEE, so the seeding must be able to write rows the
 *  reader is not bound to. */
const insertConnection = (
  db: SqliteTestFumaDb,
  row: {
    readonly rowId: string;
    readonly tenant: string;
    readonly owner: string;
    readonly subject: string;
    readonly name: string;
  },
): Promise<unknown> =>
  db.client.execute({
    sql: `INSERT INTO connection (
        row_id, tenant, owner, subject, integration, name, template, provider,
        item_ids, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      row.rowId,
      row.tenant,
      row.owner,
      row.subject,
      "github",
      row.name,
      "apiKey",
      "memory",
      JSON.stringify({ token: `item-${row.rowId}` }),
      Date.now(),
      Date.now(),
    ],
  });

const seedTwoSubjects = async (db: SqliteTestFumaDb): Promise<void> => {
  await insertConnection(db, {
    rowId: "c-a",
    tenant: TENANT,
    owner: "user",
    subject: SUBJECT_A,
    name: "a-personal",
  });
  await insertConnection(db, {
    rowId: "c-b",
    tenant: TENANT,
    owner: "user",
    subject: SUBJECT_B,
    name: "b-personal",
  });
  await insertConnection(db, {
    rowId: "c-org",
    tenant: TENANT,
    owner: "org",
    subject: "",
    name: "shared",
  });
  // Another tenant entirely — never visible at any reach.
  await insertConnection(db, {
    rowId: "c-other",
    tenant: OTHER_TENANT,
    owner: "user",
    subject: SUBJECT_A,
    name: "other-tenant",
  });
};

describe("owner policy reach", () => {
  it.effect("bound reach still sees only the subject's own rows plus org rows", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        await seedTwoSubjects(db);

        const bound = withQueryContext(db.db, { tenant: TENANT, subject: SUBJECT_A });
        const rows = await bound.findMany("connection", {});

        expect(rows.map((row) => row.name).sort()).toEqual(["a-personal", "shared"]);
      }),
    ),
  );

  it.effect("tenant reach reads across every subject in the tenant", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        await seedTwoSubjects(db);

        const platform = withQueryContext(db.db, {
          tenant: TENANT,
          subject: SUBJECT_A,
          reach: "tenant",
        });
        const rows = await platform.findMany("connection", {});

        // The other subject's rows are now visible — that is the whole point.
        expect(rows.map((row) => row.name).sort()).toEqual(["a-personal", "b-personal", "shared"]);
      }),
    ),
  );

  it.effect("tenant reach NEVER reads across tenants", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        await seedTwoSubjects(db);

        const platform = withQueryContext(db.db, {
          tenant: TENANT,
          subject: SUBJECT_A,
          reach: "tenant",
        });
        const rows = await platform.findMany("connection", {});

        // `tenant` is the one clause reach never relaxes.
        expect(rows.every((row) => row.tenant === TENANT)).toBe(true);
        expect(rows.map((row) => row.name)).not.toContain("other-tenant");
      }),
    ),
  );

  it.effect("tenant reach with a null subject reads the whole tenant, not just org rows", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        await seedTwoSubjects(db);

        // The shape an org-level API key produces: no bound subject at all.
        const platform = withQueryContext(db.db, {
          tenant: TENANT,
          subject: null,
          reach: "tenant",
        });
        const rows = await platform.findMany("connection", {});

        expect(rows.map((row) => row.name).sort()).toEqual(["a-personal", "b-personal", "shared"]);
      }),
    ),
  );

  // -------------------------------------------------------------------------
  // The security property: reach widens READS ONLY.
  // -------------------------------------------------------------------------

  it.effect("tenant reach cannot create rows", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        const platform = withQueryContext(db.db, {
          tenant: TENANT,
          subject: SUBJECT_A,
          reach: "tenant",
        });

        await expect(
          platform.create("connection", {
            tenant: TENANT,
            owner: "user",
            subject: SUBJECT_A,
            integration: "github",
            name: "written-by-platform-view",
            template: "apiKey",
            provider: "memory",
            item_ids: { token: "item-x" },
            created_at: new Date(),
            updated_at: new Date(),
          }),
        ).rejects.toThrow(/platform view is read-only/);
      }),
    ),
  );

  it.effect("tenant reach cannot update another subject's rows", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        await seedTwoSubjects(db);

        const platform = withQueryContext(db.db, {
          tenant: TENANT,
          subject: SUBJECT_A,
          reach: "tenant",
        });

        // Without the reach guard the widened read condition would MATCH
        // subject B's row and this update would land on it.
        await expect(
          platform.updateMany("connection", {
            where: (b) => b("name", "=", "b-personal"),
            set: { identity_label: "hijacked" },
          }),
        ).rejects.toThrow(/platform view is read-only/);

        const rows = await db.client.execute(
          "SELECT identity_label FROM connection WHERE row_id = 'c-b'",
        );
        expect(rows.rows[0]?.["identity_label"]).toBeNull();
      }),
    ),
  );

  it.effect("tenant reach cannot delete another subject's rows", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        await seedTwoSubjects(db);

        const platform = withQueryContext(db.db, {
          tenant: TENANT,
          subject: SUBJECT_A,
          reach: "tenant",
        });

        await expect(
          platform.deleteMany("connection", { where: (b) => b("name", "=", "b-personal") }),
        ).rejects.toThrow(/platform view is read-only/);

        const rows = await db.client.execute("SELECT row_id FROM connection ORDER BY row_id");
        expect(rows.rows.map((row) => String(row["row_id"]))).toEqual([
          "c-a",
          "c-b",
          "c-org",
          "c-other",
        ]);
      }),
    ),
  );

  it.effect("tenant reach cannot write the tenant-scoped subject table", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        const platform = withQueryContext(db.db, {
          tenant: TENANT,
          subject: SUBJECT_A,
          reach: "tenant",
        });

        // `subject` is tenant-scoped, so its reads were already tenant-wide —
        // the read-only property still has to hold there.
        await expect(
          platform.create("subject", {
            tenant: TENANT,
            external_id: SUBJECT_B,
            created_at: new Date(),
            last_seen_at: Date.now(),
            status: null,
          }),
        ).rejects.toThrow(/platform view is read-only/);
      }),
    ),
  );

  it.effect("bound reach writes are unaffected by the reach guard", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        // The guard must not disturb the product view: an ordinary bound
        // context writes exactly as before.
        const bound = withQueryContext(db.db, { tenant: TENANT, subject: SUBJECT_A });

        await bound.create("connection", {
          tenant: TENANT,
          owner: "user",
          subject: SUBJECT_A,
          integration: "github",
          name: "written-by-bound-view",
          template: "apiKey",
          provider: "memory",
          item_ids: { token: "item-y" },
          created_at: new Date(),
          updated_at: new Date(),
        });

        const rows = await bound.findMany("connection", {});
        expect(rows.map((row) => row.name)).toEqual(["written-by-bound-view"]);
      }),
    ),
  );

  it.effect("a bound context still cannot write outside its own subject", () =>
    Effect.promise(() =>
      withDb(async (db) => {
        const bound = withQueryContext(db.db, { tenant: TENANT, subject: SUBJECT_A });

        await expect(
          bound.create("connection", {
            tenant: TENANT,
            owner: "user",
            subject: SUBJECT_B,
            integration: "github",
            name: "cross-subject",
            template: "apiKey",
            provider: "memory",
            item_ids: { token: "item-z" },
            created_at: new Date(),
            updated_at: new Date(),
          }),
        ).rejects.toThrow(/outside the bound subject/);
      }),
    ),
  );
});
