/**
 * End-to-end: migrate with the SQL migrator, then run the upstream relations
 * scenario (test/query/relations.test.ts) through the query adapter, on every
 * provider. On MSSQL this exercises the soft foreign key engine.
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
import { relationsV1 } from "./support/schemas.ts";

const expected = fs
  .readFileSync(
    path.join(import.meta.dirname, "snapshots/upstream/query/relations.output.txt"),
    "utf8",
  )
  .trim();

const TestDB = fumadb({ schemas: [relationsV1], namespace: "test" });

const scenario = (provider: Provider) =>
  Effect.gen(function* () {
    const client = TestDB.client(sqlAdapter({ provider }));
    const migrator = yield* client.createMigrator;
    const result = yield* migrator.migrateToLatest();
    yield* result.execute;

    expect(yield* client.version).toBe("1.0.0");
    const orm = client.orm("1.0.0");
    const lines: Array<string> = [];

    lines.push("create initial records");
    yield* orm.createMany("users", [
      { id: "fuma", name: "fuma" },
      { id: "alfon", name: "alfonsus" },
      { id: "joulev", name: "joulev" },
    ]);
    yield* orm.createMany("posts", [
      { id: "1", authorId: "fuma", content: "hello world" },
      { id: "2", authorId: "joulev", relyTo: "1", attachmentUrl: "attachment-1" },
      { id: "3", authorId: "alfon", content: "hehe" },
    ]);
    yield* orm.createMany("attachments", [
      { id: "1", url: "attachment-1", data: new Uint8Array([1, 2, 3, 4]) },
    ]);

    lines.push("get initial records");
    lines.push(show(yield* orm.findMany("users", { orderBy: ["id", "asc"] })));
    lines.push(show(yield* orm.findMany("posts", { orderBy: ["id", "asc"] })));
    lines.push(show(yield* orm.findMany("attachments")));

    lines.push("delete alfon, his posts should also be deleted");
    yield* orm.deleteMany("users", { where: (b) => b("id", "=", "alfon") });
    lines.push(show(yield* orm.findMany("posts", { orderBy: ["id", "asc"] })));

    lines.push("update attachment url of post 2, attachment url should also be updated");
    yield* orm.updateMany("posts", {
      where: (b) => b("id", "=", "2"),
      set: { attachmentUrl: "attachment-1-updated" },
    });
    lines.push(show(yield* orm.findMany("attachments")));

    lines.push("delete post, attachment should also be deleted");
    yield* orm.deleteMany("posts", { where: (b) => b("id", "=", "2") });
    lines.push(show(yield* orm.findMany("attachments")));

    const duplicate = yield* orm
      .createMany("likes", [
        { postId: "1", userId: "fuma" },
        { postId: "1", userId: "fuma" },
      ])
      .pipe(Effect.exit);
    expect(duplicate._tag).toBe("Failure");

    return lines.join("\n");
  });

for (const provider of providers) {
  it.live(
    `relations end to end: ${provider}`,
    () =>
      Effect.gen(function* () {
        const output = yield* withProvider(provider, scenario(provider));
        expect(output).toBe(expected);
      }),
    { timeout: 120_000 },
  );
}
