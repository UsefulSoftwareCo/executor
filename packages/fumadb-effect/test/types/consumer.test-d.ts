/**
 * Type-level checks of the public API from a library author's point of view.
 * Compiled by `bun run typecheck`; there is nothing to run.
 */
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { fumadb, type InferFumaDB, type Orm } from "../../src/index.ts";
import { column, idColumn, schema, table } from "../../src/schema.ts";
import { sqlAdapter } from "../../src/implementation/sql/index.ts";

const v1 = schema({
  version: "1.0.0",
  tables: {
    users: table("users", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))).generated(),
      name: column("name", Schema.String),
      age: column("age", Schema.NullOr(Schema.Int)),
    }),
    posts: table("posts", {
      id: idColumn("id", Schema.String.check(Schema.isUUID())),
      author: column("author", Schema.String.check(Schema.isMaxLength(255))),
      body: column("body", Schema.String).default(""),
      metadata: column("metadata", Schema.Json),
    }),
  },
  relations: {
    users: ({ many }) => ({ posts: many("posts") }),
    posts: ({ one }) => ({ writer: one("users", ["author", "id"]).foreignKey() }),
  },
});

const DB = fumadb({ namespace: "types", schemas: [v1] });
type Client = InferFumaDB<typeof DB>;
declare const client: Client;
const orm = client.orm("1.0.0");

// @ts-expect-error unknown version
client.orm("2.0.0");

export const program = Effect.gen(function* () {
  const users = yield* orm.findMany("users", {
    select: ["name", "age"],
    join: (b) => b.posts({ select: ["body"] }),
  });
  const user = users[0];
  if (user !== undefined) {
    const name: string = user.name;
    const age: number | null = user.age;
    const bodies: Array<string> = user.posts.map((post) => post.body);
    // @ts-expect-error id was not selected
    const missing: unknown = user.id;
    void [name, age, bodies, missing];
  }

  const post = yield* orm.findFirst("posts", {
    where: (b) => b("id", "=", "x"),
    join: (b) => b.writer(),
  });
  if (post !== null) {
    // a `one` join is null when no related row exists
    const writerName: string | undefined = post.writer?.name;
    void writerName;
  }
  const first = yield* orm.findFirst("users");
  void first;

  const postsWithCount = yield* orm.findMany("posts", {
    select: ["id"],
    computed: [
      { kind: "jsonArrayLength", column: "metadata", alias: "fileCount" },
      { kind: "jsonArrayLength", column: "metadata", alias: "otherCount" },
    ],
  });
  const fileCount: number | null = postsWithCount[0]?.fileCount ?? null;
  const otherCount: number | null = postsWithCount[0]?.otherCount ?? null;
  const selectedId: string | undefined = postsWithCount[0]?.id;
  // @ts-expect-error computed projections preserve literal alias names
  void postsWithCount[0]?.nonexistentAlias;
  // @ts-expect-error unselected columns do not appear in a computed result
  void postsWithCount[0]?.body;
  const firstCount = yield* orm.findFirst("posts", {
    select: [],
    computed: [{ kind: "jsonArrayLength", column: "metadata", alias: "fileCount" }],
  });
  const firstValue: number | null = firstCount?.fileCount ?? null;
  yield* orm.findMany("users", {
    join: (b) =>
      b.posts({
        // @ts-expect-error computed projections are only supported on the root query
        computed: [{ kind: "jsonArrayLength", column: "metadata", alias: "fileCount" }],
      }),
  });
  void [fileCount, otherCount, selectedId, firstValue];

  // @ts-expect-error name is required on insert
  yield* orm.create("users", { age: 1 });
  yield* orm.create("users", { name: "ok" });
  // @ts-expect-error the id column cannot be updated
  yield* orm.updateMany("users", { set: { id: "no" } });
  // @ts-expect-error unknown column in where
  yield* orm.count("users", { where: (b) => b("nope", "=", 1) });
  // @ts-expect-error wrong value type for the column
  yield* orm.count("users", { where: (b) => b("age", "=", "str") });

  const row = yield* orm.upsert("users", {
    where: (b) => b("id", "=", "a"),
    create: { name: "a" },
    update: { name: "b" },
    returning: true,
  });
  const rowName: string = row.name;
  const nothing: void = yield* orm.upsert("users", {
    where: (b) => b("id", "=", "a"),
    create: { name: "a" },
    update: {},
  });
  void [rowName, nothing];
});

type Requirements = typeof program extends Effect.Effect<unknown, unknown, infer R> ? R : never;
export const requirements: [Requirements] extends [SqlClient]
  ? "ok"
  : "the program needs more than SqlClient" = "ok";

export const bound: Orm<typeof v1, SqlClient> = DB.client(sqlAdapter({ provider: "sqlite" })).orm(
  "1.0.0",
);
