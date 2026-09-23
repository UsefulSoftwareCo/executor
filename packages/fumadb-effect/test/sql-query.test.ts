/**
 * The SQL query adapter, run against every provider.
 *
 * The main test replays upstream fumadb's `test/query/query.test.ts` step by
 * step and compares the joined lines with the upstream output file. The
 * focused tests cover behaviour the upstream scenario does not reach.
 */
import { it } from "@effect/vitest";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { SqlError } from "effect/unstable/sql/SqlError";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect } from "vitest";
import { fumadb } from "../src/index.ts";
import type { Provider } from "../src/contracts/provider.ts";
import { sqlAdapter } from "../src/implementation/sql/index.ts";
import { providers, withProvider } from "./support/databases.ts";
import { show } from "./support/inspect.ts";
import { createTables } from "./support/query-ddl.ts";
import { queryV1 } from "./support/schemas.ts";

const myDB = fumadb({ namespace: "test", schemas: [queryV1] })
  .names.prefix(true)
  .names({
    users: {},
    "users.id": { sql: "user_id" },
  });

const makeOrm = (provider: Provider) => myDB.client(sqlAdapter({ provider })).orm("1.0.0");

type QueryOrm = ReturnType<typeof makeOrm>;

const upstreamOutput = fs.readFileSync(
  path.join(import.meta.dirname, "snapshots/upstream/query/query.output.txt"),
  "utf8",
);

/** Reset the database, create the schema's tables, and run `use` with the ORM. */
const withOrm = <A, E>(
  provider: Provider,
  use: (orm: QueryOrm) => Effect.Effect<A, E, SqlClient>,
): Effect.Effect<A, unknown> =>
  withProvider(
    provider,
    Effect.gen(function* () {
      const orm = makeOrm(provider);
      yield* createTables(provider, orm.schema);
      return yield* use(orm);
    }),
  );

/** Upstream `run()`, line for line. */
const upstreamScenario = (provider: Provider) =>
  Effect.gen(function* () {
    const orm = makeOrm(provider);
    yield* createTables(provider, orm.schema);
    const lines: Array<string> = [];

    lines.push("create one");
    lines.push(show(yield* orm.create("users", { id: "generated-cuid", name: "fuma" })));

    lines.push("create other users");
    lines.push(
      show(
        yield* orm.createMany("users", [
          { id: "alfon", name: "alfon" },
          { id: "test", name: "Test User" },
        ]),
      ),
    );

    lines.push("initial data ready");
    yield* orm.createMany("messages", [
      { user: "alfon", content: "Hello World 1 by alfon", id: "1" },
      { user: "alfon", content: "Hello World 2 by alfon", id: "2", mentionId: "1" },
    ]);
    lines.push(show(yield* orm.findMany("users", { orderBy: ["id", "asc"] })));
    lines.push(show(yield* orm.findMany("messages", { orderBy: ["id", "asc"] })));

    lines.push("test joins: user -> messages -> mentioned by");
    lines.push(
      show(
        yield* orm.findMany("users", {
          orderBy: ["id", "asc"],
          join: (b) =>
            b.messages({
              orderBy: ["id", "asc"],
              join: (b) => b.mentionedBy({ join: (b) => b.author() }),
            }),
        }),
      ),
    );

    lines.push("test joins: user -> messages (conditional) -> author");
    lines.push(
      show(
        yield* orm.findMany("users", {
          orderBy: ["id", "asc"],
          join: (b) =>
            b.messages({
              orderBy: ["id", "asc"],
              select: ["content"],
              limit: 1,
              where: (b) => b("content", "contains", "alfon"),
              join: (b) => b.author(),
            }),
        }),
      ),
    );

    lines.push(`count users: ${yield* orm.count("users")}`);

    const getBob = orm.findFirst("users", { where: (b) => b("id", "=", "bob") });
    const upsertBob = (name: string) =>
      orm.upsert("users", {
        where: (b) => b("id", "=", "bob"),
        create: { id: "bob", name },
        update: { name },
        returning: false,
      });

    lines.push("upsert bob: should be created as sad");
    yield* upsertBob("Bob is sad");
    lines.push(show(yield* getBob));

    lines.push("upsert bob: should be updated to happy");
    yield* upsertBob("Bob is happy");
    lines.push(show(yield* getBob));

    lines.push("upsert bob with force returning: should return the updated row");
    lines.push(
      show(
        yield* orm.upsert("users", {
          where: (b) => b("id", "=", "bob"),
          create: { id: "bob", name: "Bob is excited" },
          update: { name: "Bob is excited" },
          returning: true,
        }),
      ),
    );

    lines.push("upsert charlie with force returning: should return the created row");
    lines.push(
      show(
        yield* orm.upsert("users", {
          where: (b) => b("id", "=", "charlie"),
          create: { id: "charlie", name: "Charlie is new" },
          update: { name: "Charlie is updated" },
          returning: true,
        }),
      ),
    );

    lines.push("insert with binary data");
    lines.push(
      show(
        yield* orm.create("messages", {
          id: "image-test",
          user: "alfon",
          content: "test",
          image: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        }),
      ),
    );

    const rollback = yield* Effect.flip(
      orm.transaction(
        Effect.gen(function* () {
          yield* orm.createMany("messages", [
            { id: "transaction-1", user: "alfon", content: "test message" },
            { id: "transaction-2", user: "bob", content: "haha" },
          ]);
          yield* orm.deleteMany("messages", { where: (b) => b("id", "=", "image-test") });

          lines.push("should be able to select affected records in transaction");
          lines.push(show(yield* orm.findMany("messages", { orderBy: ["id", "asc"] })));

          return yield* Effect.fail("Rollback!" as const);
        }),
      ),
    );
    expect(rollback).toBe("Rollback!");

    lines.push("after rollback, the changes should not be kept");
    lines.push(show(yield* orm.findMany("messages", { orderBy: ["id", "asc"] })));

    // MSSQL defaults to `relationMode: "fumadb"`, where the soft foreign key
    // engine (a separate component) enforces this instead of the database.
    if (provider !== "mssql") {
      const failure = yield* Effect.flip(
        orm.create("messages", { user: "invalid", id: "invalid-message" }),
      );
      expect(failure).toBeInstanceOf(SqlError);
      if (failure instanceof SqlError) expect(failure.reason._tag).toBe("ConstraintError");
    }

    return lines.join("\n");
  });

describe("sql query adapter", () => {
  for (const provider of providers) {
    describe(provider, () => {
      it.effect("matches the upstream query scenario", () =>
        Effect.gen(function* () {
          const output = yield* withProvider(provider, upstreamScenario(provider));
          expect(output).toBe(upstreamOutput);
        }),
      );

      it.effect("escapes LIKE wildcards in the value", () =>
        withOrm(provider, (orm) =>
          Effect.gen(function* () {
            yield* orm.createMany("users", [
              { id: "1", name: "100% sure" },
              { id: "2", name: "abc" },
              { id: "3", name: "a_b" },
              { id: "4", name: "axb" },
              { id: "5", name: "[abc]" },
            ]);
            const names = (rows: ReadonlyArray<{ readonly name: string }>) =>
              rows.map((row) => row.name).sort();

            expect(
              names(yield* orm.findMany("users", { where: (b) => b("name", "contains", "%") })),
            ).toEqual(["100% sure"]);
            expect(
              names(yield* orm.findMany("users", { where: (b) => b("name", "contains", "a_b") })),
            ).toEqual(["a_b"]);
            expect(
              names(
                yield* orm.findMany("users", { where: (b) => b("name", "starts with", "100%") }),
              ),
            ).toEqual(["100% sure"]);
            expect(
              names(yield* orm.findMany("users", { where: (b) => b("name", "ends with", "sure") })),
            ).toEqual(["100% sure"]);
            expect(
              names(yield* orm.findMany("users", { where: (b) => b("name", "contains", "[a") })),
            ).toEqual(["[abc]"]);
            expect(
              names(yield* orm.findMany("users", { where: (b) => b("name", "not contains", "%") }))
                .length,
            ).toBe(4);
          }),
        ),
      );

      it.effect("compiles an empty IN list to a constant", () =>
        withOrm(provider, (orm) =>
          Effect.gen(function* () {
            yield* orm.createMany("users", [
              { id: "1", name: "one" },
              { id: "2", name: "two" },
            ]);
            expect(yield* orm.findMany("users", { where: (b) => b("id", "in", []) })).toEqual([]);
            expect(
              (yield* orm.findMany("users", { where: (b) => b("id", "not in", []) })).length,
            ).toBe(2);
            expect(
              (yield* orm.findMany("users", { where: (b) => b("id", "in", ["2"]) })).length,
            ).toBe(1);
            expect(yield* orm.count("users", { where: (b) => b("id", "in", []) })).toBe(0);
          }),
        ),
      );

      it.effect("counts zero for a where that never matches", () =>
        withOrm(provider, (orm) =>
          Effect.gen(function* () {
            yield* orm.createMany("users", [{ id: "1", name: "one" }]);
            expect(yield* orm.count("users", { where: (b) => b("id", "=", "missing") })).toBe(0);
            expect(
              yield* orm.count("users", { where: (b) => b.and(b("id", "=", "1"), false) }),
            ).toBe(0);
            expect(yield* orm.count("users")).toBe(1);
          }),
        ),
      );

      it.effect("resolves a join whose condition never matches", () =>
        withOrm(provider, (orm) =>
          Effect.gen(function* () {
            yield* orm.createMany("users", [{ id: "alfon", name: "alfon" }]);
            yield* orm.createMany("messages", [{ id: "1", user: "alfon", content: "hi" }]);

            const users = yield* orm.findMany("users", {
              join: (b) => b.messages({ where: (b) => b.and(false) }),
            });
            expect(users).toEqual([{ id: "alfon", name: "alfon", messages: [] }]);

            const messages = yield* orm.findMany("messages", {
              select: ["id"],
              join: (b) => b.mentioning({ where: (b) => b.and(false) }),
            });
            expect(messages).toEqual([{ id: "1", mentioning: null }]);
          }),
        ),
      );

      it.effect("reads a page with limit and offset", () =>
        withOrm(provider, (orm) =>
          Effect.gen(function* () {
            yield* orm.createMany(
              "users",
              ["1", "2", "3", "4", "5"].map((id) => ({ id, name: `user ${id}` })),
            );
            const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((row) => row.id);

            expect(ids(yield* orm.findMany("users", { orderBy: ["id", "asc"], limit: 2 }))).toEqual(
              ["1", "2"],
            );
            expect(
              ids(yield* orm.findMany("users", { orderBy: ["id", "asc"], limit: 2, offset: 1 })),
            ).toEqual(["2", "3"]);
            expect(
              ids(yield* orm.findMany("users", { orderBy: ["id", "asc"], offset: 3 })),
            ).toEqual(["4", "5"]);
          }),
        ),
      );

      it.effect("round-trips json values", () =>
        withOrm(provider, (orm) =>
          Effect.gen(function* () {
            const created = yield* orm.create("posts", {
              id: "00000000-0000-4000-8000-000000000001",
              title: "empty metadata",
              metadata: {},
            });
            expect(created.metadata).toEqual({});

            yield* orm.createMany("posts", [
              {
                id: "00000000-0000-4000-8000-000000000002",
                title: "two",
                metadata: { views: 100 },
              },
              {
                id: "00000000-0000-4000-8000-000000000003",
                title: "three",
                metadata: [1, "a", null],
              },
            ]);
            const rows = yield* orm.findMany("posts", {
              select: ["title", "metadata"],
              orderBy: ["title", "asc"],
            });
            expect(rows).toEqual([
              { title: "empty metadata", metadata: {} },
              { title: "three", metadata: [1, "a", null] },
              { title: "two", metadata: { views: 100 } },
            ]);
          }),
        ),
      );

      it.effect("upserts with returning", () =>
        withOrm(provider, (orm) =>
          Effect.gen(function* () {
            const created = yield* orm.upsert("users", {
              where: (b) => b("id", "=", "zed"),
              create: { id: "zed", name: "created" },
              update: { name: "updated" },
              returning: true,
            });
            expect(created).toEqual({ id: "zed", name: "created" });

            const updated = yield* orm.upsert("users", {
              where: (b) => b("id", "=", "zed"),
              create: { id: "zed", name: "created again" },
              update: { name: "updated" },
              returning: true,
            });
            expect(updated).toEqual({ id: "zed", name: "updated" });
            expect(yield* orm.count("users")).toBe(1);
          }),
        ),
      );

      if (provider === "postgresql" || provider === "cockroachdb" || provider === "sqlite") {
        it.effect("arbitrates concurrent primary-key upserts", () =>
          withOrm(provider, (orm) =>
            Effect.gen(function* () {
              const rows = yield* Effect.forEach(
                Array.from({ length: 8 }, (_, index) => index),
                (index) =>
                  orm.upsert("users", {
                    where: (b) => b("id", "=", "shared"),
                    create: { id: "shared", name: `writer-${index}` },
                    update: { name: `writer-${index}` },
                    returning: true,
                  }),
                { concurrency: 8 },
              );
              expect(rows).toHaveLength(8);
              expect(rows.every((row) => row.id === "shared")).toBe(true);
              expect(yield* orm.count("users")).toBe(1);
              const unchanged = yield* orm.upsert("users", {
                where: (b) => b("id", "=", "shared"),
                create: { id: "shared", name: "unused" },
                update: {},
                returning: true,
              });
              expect(unchanged.name).toMatch(/^writer-/);
            }),
          ),
        );
      }

      it.effect("rolls back a transaction and a nested transaction", () =>
        withOrm(provider, (orm) =>
          Effect.gen(function* () {
            const failure = yield* Effect.flip(
              orm.transaction(
                Effect.gen(function* () {
                  yield* orm.createMany("users", [{ id: "rolled-back", name: "gone" }]);
                  return yield* Effect.fail("stop" as const);
                }),
              ),
            );
            expect(failure).toBe("stop");
            expect(yield* orm.count("users")).toBe(0);

            yield* orm.transaction(
              Effect.gen(function* () {
                yield* orm.createMany("users", [{ id: "outer", name: "kept" }]);
                const inner = yield* Effect.flip(
                  orm.transaction(
                    Effect.gen(function* () {
                      yield* orm.createMany("users", [{ id: "inner", name: "dropped" }]);
                      return yield* Effect.fail("stop" as const);
                    }),
                  ),
                );
                expect(inner).toBe("stop");
              }),
            );

            const remaining = yield* orm.findMany("users", {
              select: ["id"],
              orderBy: ["id", "asc"],
            });
            expect(remaining.map((row) => row.id)).toEqual(["outer"]);
          }),
        ),
      );
    });
  }
});
