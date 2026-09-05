import { expect, test } from "@effect/vitest";

import { column, idColumn, schema, table } from "../../schema";
import { fromDrizzle } from "./query";

// `replaceMany`'s fence is only as good as its reading of the guard update's
// affected-row count, and every driver spells that differently. A recording
// fake of the Drizzle handle plays each driver's result shape so the fence
// is proven to hold — and to refuse to fence at all — without a live server.
const v1 = schema({
  version: "1.0.0",
  tables: {
    owners: table("owners", {
      id: idColumn("id", "varchar(255)"),
      token: column("token", "string"),
    }),
    rows: table("rows", {
      id: idColumn("id", "varchar(255)"),
      value: column("value", "string"),
    }),
  },
});

interface FakeOptions {
  /** What the guard UPDATE resolves to. */
  readonly updateResult: unknown;
}

const createFakePgDb = (options: FakeOptions) => {
  const events: string[] = [];
  const fakeTables = {
    owners: { id: { name: "id" }, token: { name: "token" } },
    rows: { id: { name: "id" }, value: { name: "value" } },
  };
  const makeHandle = (label: string) => ({
    _: { fullSchema: fakeTables },
    update: () => ({
      set: () => {
        const builder = {
          where: () => builder,
          then: (resolve: (value: unknown) => void) => {
            events.push(`${label}:update`);
            resolve(options.updateResult);
          },
        };
        return builder;
      },
    }),
    delete: () => {
      const builder = {
        where: () => builder,
        then: (resolve: (value: unknown) => void) => {
          events.push(`${label}:delete`);
          resolve(undefined);
        },
      };
      return builder;
    },
    insert: () => ({
      values: () => ({
        then: (resolve: (value: unknown) => void) => {
          events.push(`${label}:insert`);
          resolve(undefined);
        },
      }),
    }),
    transaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => {
      events.push("transaction:begin");
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- fake driver mirrors commit/rollback
      try {
        const result = await callback(makeHandle("tx"));
        events.push("transaction:commit");
        return result;
      } catch (error) {
        events.push("transaction:rollback");
        throw error;
      }
    },
  });
  return { db: makeHandle("root"), events };
};

const replace = (db: unknown) => {
  const orm = fromDrizzle(v1, db, "postgresql");
  const owners = v1.tables.owners;
  const rows = v1.tables.rows;
  expect(orm.internal.replaceMany).toBeDefined();
  return orm.internal.replaceMany!({
    guard: { table: owners, where: undefined, set: { token: null } },
    deletes: [{ table: rows, where: undefined }],
    inserts: [{ table: rows, values: [{ id: "r1", value: "a" }] }],
  });
};

test("postgres.js `count: 0` is a guard miss: the transaction rolls back and nothing applies", async () => {
  // postgres.js hands Drizzle a RowList whose affected count is `count`.
  const { db, events } = createFakePgDb({ updateResult: Object.assign([], { count: 0 }) });
  const out = await replace(db);
  expect(out).toEqual({ applied: false });
  expect(events).toEqual(["transaction:begin", "tx:update", "transaction:rollback"]);
});

test("postgres.js `count: 1` is a guard hit: deletes and inserts run in the same transaction", async () => {
  const { db, events } = createFakePgDb({ updateResult: Object.assign([], { count: 1 }) });
  const out = await replace(db);
  expect(out).toEqual({ applied: true });
  expect(events).toEqual([
    "transaction:begin",
    "tx:update",
    "tx:delete",
    "tx:insert",
    "transaction:commit",
  ]);
});

test("node-postgres `rowCount`, libsql `rowsAffected`, better-sqlite3 `changes`, D1 `meta.changes`, mysql2 `[header].affectedRows` are all read", async () => {
  for (const updateResult of [
    { rowCount: 0 },
    { rowsAffected: 0 },
    { changes: 0 },
    { meta: { changes: 0 } },
    [{ affectedRows: 0, fieldCount: 0 }, []],
  ]) {
    const { db } = createFakePgDb({ updateResult });
    expect(await replace(db), JSON.stringify(updateResult)).toEqual({ applied: false });
  }
  for (const updateResult of [
    { rowCount: 2 },
    { rowsAffected: 1 },
    { changes: 1 },
    { meta: { changes: 1 } },
    [{ affectedRows: 1, fieldCount: 0 }, []],
  ]) {
    const { db } = createFakePgDb({ updateResult });
    expect(await replace(db), JSON.stringify(updateResult)).toEqual({ applied: true });
  }
});

test("a driver result with no affected-row count refuses to fence rather than silently matching", async () => {
  const { db, events } = createFakePgDb({ updateResult: { ok: true } });
  await expect(replace(db)).rejects.toThrow(/affected-row count/);
  // The transaction was aborted: nothing after the guard ran.
  expect(events).toEqual(["transaction:begin", "tx:update", "transaction:rollback"]);
});
