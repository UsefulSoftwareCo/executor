import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Exit, ManagedRuntime, Result, Schema } from "effect";
import * as Sqlite from "@effect/sql-sqlite-node/SqliteClient";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  Row,
  PaginationResult,
  makeSqliteDatabase,
  defaultDatabaseLimits,
  type DatabaseSession,
} from "../src/index.ts";

const schema = {
  messages: {
    fields: {
      mailbox: { kind: "string" },
      score: { kind: "number", optional: true },
      read: { kind: "boolean", default: false },
    },
    indexes: [{ name: "by_mailbox", fields: ["mailbox", "score"] }],
  },
};
const plan = {
  table: "messages",
  index: "by_mailbox",
  order: "asc" as const,
  clauses: [{ field: "mailbox", op: "eq" as const, value: "one" }],
};
const row = Schema.decodeUnknownSync(Row);
const page = Schema.decodeUnknownSync(PaginationResult);

test("SQLite scopes enforce typed writes, isolation, rollback, indexes, cursors and limits", async () => {
  const runtime = ManagedRuntime.make(Sqlite.layer({ filename: ":memory:" }));
  try {
    const db = await runtime.runPromise(
      Effect.flatMap(SqlClient, (sql) => makeSqliteDatabase({ sql, schema, crypto })),
    );
    const inserted = await runtime.runPromise(
      db.mutate((session) =>
        Effect.forEach([null, -10, -0.1, 0, 3, 20], (score) =>
          session.execute({ kind: "insert", table: "messages", value: { mailbox: "one", score } }),
        ),
      ),
    );
    assert.equal(inserted.length, 6);
    assert.equal(row(inserted[0]).read, false);
    const values = await runtime.runPromise(
      db.read((session) => session.execute({ kind: "query", plan, terminal: { kind: "collect" } })),
    );
    assert.deepEqual(
      Schema.decodeUnknownSync(Schema.Array(Row))(values).map((value) => value.score),
      [undefined, -10, -0.1, 0, 3, 20],
    );
    const upper = await runtime.runPromise(
      db.read((session) =>
        session.execute({
          kind: "query",
          plan: { ...plan, clauses: [...plan.clauses, { field: "score", op: "lt", value: 0 }] },
          terminal: { kind: "collect" },
        }),
      ),
    );
    assert.deepEqual(
      Schema.decodeUnknownSync(Schema.Array(Row))(upper).map((value) => value.score),
      [-10, -0.1],
    );
    const first = page(
      await runtime.runPromise(
        db.read((session) =>
          session.execute({
            kind: "query",
            plan,
            terminal: { kind: "paginate", numItems: 2, cursor: null },
          }),
        ),
      ),
    );
    assert.equal(first.isDone, false);
    assert.ok(first.continueCursor);
    const second = page(
      await runtime.runPromise(
        db.read((session) =>
          session.execute({
            kind: "query",
            plan,
            terminal: { kind: "paginate", numItems: 2, cursor: first.continueCursor },
          }),
        ),
      ),
    );
    assert.deepEqual(
      second.page.map((value) => value.score),
      [-0.1, 0],
    );
    const wrongQuery = await runtime.runPromise(
      db
        .read((session) =>
          session.execute({
            kind: "query",
            plan: { ...plan, order: "desc" },
            terminal: { kind: "paginate", numItems: 2, cursor: first.continueCursor },
          }),
        )
        .pipe(Effect.result),
    );
    assert.ok(Result.isFailure(wrongQuery));
    assert.equal(wrongQuery.failure.reason, "cursor");

    const rollback = await runtime.runPromise(
      db
        .mutate((session) =>
          Effect.gen(function* () {
            yield* session.execute({
              kind: "insert",
              table: "messages",
              value: { mailbox: "rolled back" },
            });
            yield* session
              .execute({ kind: "insert", table: "messages", value: { mailbox: null } })
              .pipe(Effect.catch(() => Effect.void));
          }),
        )
        .pipe(Effect.result),
    );
    assert.ok(Result.isFailure(rollback));
    const count = await runtime.runPromise(
      db.read((session) =>
        session.execute({
          kind: "query",
          plan: { ...plan, index: "by_creation", clauses: [] },
          terminal: { kind: "count" },
        }),
      ),
    );
    assert.equal(count, 6);
    const forbidden = await runtime.runPromise(
      db
        .read((session) => session.execute({ kind: "delete", table: "messages", id: "missing" }))
        .pipe(Effect.result),
    );
    assert.ok(Result.isFailure(forbidden));
    assert.equal(forbidden.failure.reason, "readonly");
    let expired: DatabaseSession | undefined;
    await runtime.runPromise(
      db.read((session) =>
        Effect.sync(() => {
          expired = session;
        }),
      ),
    );
    assert.ok(expired);
    const closed = await runtime.runPromise(
      expired.execute({ kind: "get", table: "messages", id: "missing" }).pipe(Effect.result),
    );
    assert.ok(Result.isFailure(closed));
    assert.equal(closed.failure.reason, "closed");

    // A JS Promise boundary must use the same SQLite transaction rather than deadlocking.
    const atomic = await runtime.runPromise(
      db.mutate((session) =>
        Effect.tryPromise(async () => {
          const value = row(
            await Effect.runPromise(
              session.execute({ kind: "insert", table: "messages", value: { mailbox: "promise" } }),
            ),
          );
          return await Effect.runPromise(
            session.execute({ kind: "get", table: "messages", id: String(value.id) }),
          );
        }),
      ),
    );
    assert.equal(row(atomic).mailbox, "promise");
    const incompatible = await runtime.runPromise(
      Effect.flatMap(SqlClient, (sql) => makeSqliteDatabase({ sql, schema: {}, crypto })).pipe(
        Effect.result,
      ),
    );
    assert.ok(Result.isFailure(incompatible));
    assert.equal(incompatible.failure.reason, "schema_changed");
  } finally {
    await runtime.dispose();
  }
});

test("bounded scans fail instead of truncating and a defect cannot leak a live transaction", async () => {
  const runtime = ManagedRuntime.make(Sqlite.layer({ filename: ":memory:" }));
  try {
    const db = await runtime.runPromise(
      Effect.flatMap(SqlClient, (sql) =>
        makeSqliteDatabase({
          sql,
          schema,
          crypto,
          limits: { ...defaultDatabaseLimits, rowsReturned: 2, rowsRead: 4 },
        }),
      ),
    );
    await runtime.runPromise(
      db.mutate((session) =>
        Effect.forEach([1, 2, 3], (score) =>
          session.execute({ kind: "insert", table: "messages", value: { mailbox: "one", score } }),
        ),
      ),
    );
    const limited = await runtime.runPromise(
      db
        .read((session) => session.execute({ kind: "query", plan, terminal: { kind: "collect" } }))
        .pipe(Effect.result),
    );
    assert.ok(Result.isFailure(limited));
    assert.equal(limited.failure.reason, "limit");
    const valid = page(
      await runtime.runPromise(
        db.read((session) =>
          session.execute({
            kind: "query",
            plan,
            terminal: { kind: "paginate", numItems: 2, cursor: null },
          }),
        ),
      ),
    );
    assert.equal(valid.page.length, 2);
    assert.equal(valid.isDone, false);
    const tampered = await runtime.runPromise(
      db
        .read((session) =>
          session.execute({
            kind: "query",
            plan,
            terminal: { kind: "paginate", numItems: 2, cursor: "invalid-token" },
          }),
        )
        .pipe(Effect.result),
    );
    assert.ok(Result.isFailure(tampered));
    assert.equal(tampered.failure.reason, "cursor");
    let leaked: DatabaseSession | undefined;
    const defective = await runtime.runPromiseExit(
      db.mutate((session) => {
        leaked = session;
        throw new Error("synthetic defect");
      }),
    );
    assert.ok(Exit.isFailure(defective));
    assert.ok(leaked);
    const closed = await runtime.runPromise(
      leaked
        .execute({ kind: "insert", table: "messages", value: { mailbox: "leaked" } })
        .pipe(Effect.result),
    );
    assert.ok(Result.isFailure(closed));
    assert.equal(closed.failure.reason, "closed");
    const count = await runtime.runPromise(
      db.read((session) => session.execute({ kind: "query", plan, terminal: { kind: "count" } })),
    );
    assert.equal(count, 3);
  } finally {
    await runtime.dispose();
  }
});

test("mutation receipts commit with writes, replay saved results, and roll back on failure", async () => {
  const runtime = ManagedRuntime.make(Sqlite.layer({ filename: ":memory:" }));
  try {
    const db = await runtime.runPromise(
      Effect.flatMap(SqlClient, (sql) => makeSqliteDatabase({ sql, schema, crypto })),
    );
    const insert = (session: DatabaseSession) =>
      session.execute({ kind: "insert", table: "messages", value: { mailbox: "receipt" } });
    const first = await runtime.runPromise(
      db.mutate((session) => session.once("one", "input-a", () => insert(session))),
    );
    // A caller lost the acknowledgement after commit: repeat the same durable step.
    const replay = await runtime.runPromise(
      db.mutate((session) =>
        session.once("one", "input-a", () => Effect.die("Must not repeat a committed mutation")),
      ),
    );
    assert.deepEqual(replay, first);
    const mismatch = await runtime.runPromise(
      db
        .mutate((session) => session.once("one", "input-b", () => insert(session)))
        .pipe(Effect.result),
    );
    assert.ok(Result.isFailure(mismatch));
    assert.equal(mismatch.failure.reason, "replay");
    const rolledBack = await runtime.runPromise(
      db
        .mutate((session) =>
          session.once("two", "input", () =>
            insert(session).pipe(Effect.flatMap(() => Effect.fail("rollback"))),
          ),
        )
        .pipe(Effect.result),
    );
    assert.ok(Result.isFailure(rolledBack));
    // Neither the write nor the receipt survived, so a retry can commit.
    await runtime.runPromise(
      db.mutate((session) => session.once("two", "input", () => insert(session))),
    );
    const invalid = await runtime.runPromise(
      db
        .mutate((session) =>
          session.once("three", "input", () =>
            insert(session).pipe(Effect.as("x".repeat(1024 * 1024 + 1))),
          ),
        )
        .pipe(Effect.result),
    );
    assert.ok(Result.isFailure(invalid));
    const count = await runtime.runPromise(
      db.read((session) =>
        session.execute({
          kind: "query",
          plan: { ...plan, index: "by_creation", clauses: [] },
          terminal: { kind: "count" },
        }),
      ),
    );
    assert.equal(count, 2);
  } finally {
    await runtime.dispose();
  }
});
