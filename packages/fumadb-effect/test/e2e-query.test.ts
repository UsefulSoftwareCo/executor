/**
 * End-to-end: migrate with the SQL migrator, then run the upstream query
 * scenario (test/query/query.test.ts) through the query adapter, on every
 * provider, and compare with the upstream snapshot.
 */
import { it } from "@effect/vitest";
import { Effect } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import { expect } from "vitest";
import { fumadb } from "../src/index.ts";
import type { Provider } from "../src/contracts/provider.ts";
import { sqlAdapter } from "../src/implementation/sql/index.ts";
import { providers, withProvider } from "./support/databases.ts";
import { show } from "./support/inspect.ts";
import { queryV1 } from "./support/schemas.ts";

const expected = fs
  .readFileSync(path.join(import.meta.dirname, "snapshots/upstream/query/query.output.txt"), "utf8")
  .trim();

const myDB = fumadb({ namespace: "test", schemas: [queryV1] })
  .names.prefix(true)
  .names({ "users.id": { sql: "user_id" } });

const scenario = (provider: Provider) =>
  Effect.gen(function* () {
    const client = myDB.client(sqlAdapter({ provider }));
    const migrator = yield* client.createMigrator;
    yield* (yield* migrator.migrateToLatest()).execute;
    const orm = client.orm("1.0.0");
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
    lines.push(
      show(yield* orm.findMany("users", { orderBy: ["id", "asc"] })),
      show(yield* orm.findMany("messages", { orderBy: ["id", "asc"] })),
    );

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

    const rollback = yield* orm
      .transaction(
        Effect.gen(function* () {
          yield* orm.createMany("messages", [
            { id: "transaction-1", user: "alfon", content: "test message" },
            { id: "transaction-2", user: "bob", content: "haha" },
          ]);
          yield* orm.deleteMany("messages", { where: (b) => b("id", "=", "image-test") });
          lines.push("should be able to select affected records in transaction");
          lines.push(show(yield* orm.findMany("messages", { orderBy: ["id", "asc"] })));
          return yield* Effect.fail(new Error("Rollback!"));
        }),
      )
      .pipe(Effect.exit);
    expect(rollback._tag).toBe("Failure");

    lines.push("after rollback, the changes should not be kept");
    lines.push(show(yield* orm.findMany("messages", { orderBy: ["id", "asc"] })));

    const invalid = yield* orm
      .create("messages", { user: "invalid", id: "invalid-message" })
      .pipe(Effect.exit);
    expect(invalid._tag).toBe("Failure");

    return lines.join("\n");
  });

for (const provider of providers) {
  it.live(
    `query end to end: ${provider}`,
    () =>
      Effect.gen(function* () {
        const output = yield* withProvider(provider, scenario(provider));
        expect(output).toBe(expected);
      }),
    { timeout: 120_000 },
  );
}

it.live(
  "json column with empty object",
  () =>
    Effect.gen(function* () {
      for (const provider of providers) {
        yield* withProvider(
          provider,
          Effect.gen(function* () {
            const client = myDB.client(sqlAdapter({ provider }));
            const migrator = yield* client.createMigrator;
            yield* (yield* migrator.migrateToLatest()).execute;
            const orm = client.orm("1.0.0");
            const created = yield* orm.create("posts", {
              id: "00000000-0000-4000-8000-000000000001",
              title: "Post with empty metadata",
              metadata: {},
            });
            expect(created).toEqual({
              id: "00000000-0000-4000-8000-000000000001",
              title: "Post with empty metadata",
              metadata: {},
            });
            yield* orm.createMany("posts", [
              { id: "00000000-0000-4000-8000-000000000002", title: "Post 2", metadata: {} },
              {
                id: "00000000-0000-4000-8000-000000000003",
                title: "Post 3",
                metadata: { views: 100 },
              },
            ]);
            const all = yield* orm.findMany("posts", { orderBy: ["id", "asc"] });
            expect(all).toHaveLength(3);
            expect(all[0]?.metadata).toEqual({});
            expect(all[1]?.metadata).toEqual({});
            expect(all[2]?.metadata).toEqual({ views: 100 });
          }),
        );
      }
    }),
  { timeout: 300_000 },
);
