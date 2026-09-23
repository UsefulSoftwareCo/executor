// What does the Schema-first API infer for a library author?
import { Effect, Option, Schema } from "effect";
import { fumadb, type InferFumaDB } from "../../src/index.ts";
import { column, idColumn, schema, table } from "../../src/schema.ts";

const UserId = Schema.String.pipe(Schema.brand("UserId"));
const Email = Schema.String.check(Schema.isPattern(/@/));

const v1 = schema({
  version: "1.0.0",
  tables: {
    users: table("users", {
      id: idColumn("id", UserId).generated(),
      name: column("name", Schema.String),
      email: column("email", Schema.NullOr(Email)).unique(),
      age: column("age", Schema.Int).default(0),
      createdAt: column("created_at", Schema.DateTimeUtcFromDate).now(),
      settings: column("settings", Schema.Struct({ theme: Schema.Literals(["light", "dark"]) })),
      avatar: column("avatar", Schema.NullOr(Schema.Uint8Array)),
    }),
    posts: table("posts", {
      id: idColumn("id", Schema.String.check(Schema.isUUID())),
      author: column("author", UserId),
      body: column("body", Schema.String).default(""),
    }),
  },
  relations: {
    users: ({ many }) => ({ posts: many("posts") }),
    posts: ({ one }) => ({ writer: one("users", ["author", "id"]).foreignKey() }),
  },
});

const DB = fumadb({ namespace: "t", schemas: [v1] });
declare const client: InferFumaDB<typeof DB>;
const orm = client.orm("1.0.0");
export const program = Effect.gen(function* () {
  const u = yield* orm.create("users", { name: "n", settings: { theme: "dark" } });
  const id: typeof UserId.Type = u.id; // branded
  const created: import("effect").DateTime.Utc = u.createdAt; // DateTime, not Date
  const theme: "light" | "dark" = u.settings.theme;
  const email: string | null = u.email;
  const rows = yield* orm.findMany("users", {
    select: ["id", "settings"],
    join: (b) => b.posts({ select: ["body"] }),
  });
  const bodies: Array<string> = rows[0]?.posts.map((p) => p.body) ?? [];
  // @ts-expect-error settings.theme must be a literal
  yield* orm.create("users", { name: "n", settings: { theme: "blue" } });
  // @ts-expect-error a plain string is not a UserId
  yield* orm.create("posts", { id: "x", author: "plain" });
  yield* orm.create("posts", { id: "x", author: u.id });
  // @ts-expect-error id cannot be updated
  yield* orm.updateMany("users", { set: { id: u.id } });
  void [id, created, theme, email, bodies];
});
// derived schemas usable standalone
const RowJson = Schema.toEncoded(v1.tables.users.row);
type Insert = typeof v1.tables.users.insert.Type;
const ok: Insert = { name: "n", settings: { theme: "light" } };
void [RowJson, ok];

// finding 2: the derived insert type must match the runtime insert struct
const strict = table("strict", {
  idPlain: idColumn("idPlain", Schema.String),
  name: column("name", Schema.String),
  payload: column("payload", Schema.Unknown),
  opt: column("opt", Schema.OptionFromNullOr(Schema.String)),
  maybe: column("maybe", Schema.NullOr(Schema.Unknown)),
  n: column("n", Schema.Int).default(0),
});
type StrictInsert = typeof strict.insert.Type;
export const okInsert: StrictInsert = { idPlain: "i", name: "n", payload: {} };
// @ts-expect-error a non-generated id is required
export const missingId: StrictInsert = { name: "n", payload: {} };
// @ts-expect-error an Unknown json column is required
export const missingPayload: StrictInsert = { idPlain: "i", name: "n" };
export const withOptionals: StrictInsert = {
  idPlain: "i",
  name: "n",
  payload: 1,
  opt: Option.some("x"),
  maybe: null,
  n: 2,
};
