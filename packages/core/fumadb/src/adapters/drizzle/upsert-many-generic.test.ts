import { expect, test } from "@effect/vitest";

import { column, idColumn, schema, table } from "../../schema";
import { fromDrizzle } from "./query";

// The generic bulk-upsert path (providers without ON CONFLICT support, e.g.
// MySQL) issues several statements per row. The unit harness has no MySQL
// server, so a recording fake of the Drizzle handle asserts the transaction
// routing instead: every per-row statement must run on the driver
// transaction's handle, and a failing row must roll the earlier rows back.
const v1 = schema({
  version: "1.0.0",
  tables: {
    rows: table("generic_rows", {
      id: idColumn("id", "varchar(255)"),
      value: column("value", "string"),
    }),
  },
});

interface FakeDbOptions {
  // A row whose `value` matches makes its INSERT fail.
  readonly failOnValue?: string;
}

const createFakeMysqlDb = (options: FakeDbOptions = {}) => {
  const committed: Record<string, unknown>[] = [];
  const events: string[] = [];
  const fakeTable = { id: { name: "id" }, value: { name: "value" } };

  const makeHandle = (label: string, sink: Record<string, unknown>[]) => ({
    _: { fullSchema: { rows: fakeTable } },
    select: () => {
      const builder = {
        from: () => builder,
        limit: () => builder,
        where: () => builder,
        execute: async (): Promise<Record<string, unknown>[]> => [],
      };
      return builder;
    },
    insert: () => ({
      values: (rows: Record<string, unknown>[]) => ({
        $returningId: async () => {
          events.push(`${label}:insert`);
          for (const row of rows) {
            if (options.failOnValue !== undefined && row["value"] === options.failOnValue) {
              // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- test forces a row's statement to fail
              throw new Error("statement failure");
            }
            sink.push(row);
          }
          return rows.map((row) => ({ id: row["id"] }));
        },
      }),
    }),
    transaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => {
      events.push("transaction:begin");
      const staged: Record<string, unknown>[] = [];
      const tx = makeHandle("tx", staged);
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- fake driver mirrors commit/rollback
      try {
        const result = await callback(tx);
        committed.push(...staged);
        events.push("transaction:commit");
        return result;
      } catch (error) {
        events.push("transaction:rollback");
        throw error;
      }
    },
  });

  // Statements on the root handle auto-commit, exactly like a driver outside
  // an explicit transaction.
  return { db: makeHandle("root", committed), committed, events };
};

const upsertAll = async (db: unknown, values: readonly { id: string; value: string }[]) => {
  const orm = fromDrizzle(v1, db, "mysql");
  const rows = v1.tables.rows;
  expect(orm.internal.upsertMany).toBeDefined();
  await orm.internal.upsertMany?.(rows, {
    target: [rows.columns.id],
    update: [rows.columns.value],
    values: values.map((value) => ({ ...value })),
  });
};

test("generic bulk upsert runs every row inside one driver transaction", async () => {
  const { db, committed, events } = createFakeMysqlDb();

  await upsertAll(db, [
    { id: "r1", value: "a" },
    { id: "r2", value: "b" },
    { id: "r3", value: "c" },
  ]);

  expect(committed.map((row) => row["id"])).toEqual(["r1", "r2", "r3"]);
  expect(events).toContain("transaction:begin");
  expect(events).toContain("transaction:commit");
  // No row statement may run on the auto-committing root handle.
  expect(events).not.toContain("root:insert");
});

test("generic bulk upsert rolls earlier rows back when a later row fails", async () => {
  const { db, committed, events } = createFakeMysqlDb({ failOnValue: "poison" });

  await expect(
    upsertAll(db, [
      { id: "r1", value: "a" },
      { id: "r2", value: "b" },
      { id: "r3", value: "poison" },
    ]),
  ).rejects.toThrow("statement failure");

  // A single logical bulk upsert must not leave a partial prefix committed.
  expect(committed).toEqual([]);
  expect(events).toContain("transaction:rollback");
});
