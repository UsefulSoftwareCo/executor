/**
 * The soft foreign key engine (`relationMode: "fumadb"`).
 *
 * Every case runs against the in-memory adapter in `support/memory-adapter.ts`,
 * so the rules are checked deterministically and no database is needed.
 */
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { SqlError } from "effect/unstable/sql/SqlError";
import { describe, expect } from "vitest";
import type { OrmError } from "../src/contracts/query.ts";
import type { OrmAdapter } from "../src/contracts/query-adapter.ts";
import { toOrm } from "../src/implementation/query/orm.ts";
import { createSoftForeignKey } from "../src/implementation/query/soft-foreign-key.ts";
import { column, idColumn, schema, table } from "../src/schema.ts";
import type { AnySchema } from "../src/contracts/schema/schema.ts";
import { makeMemoryAdapter } from "./support/memory-adapter.ts";
import { relationsV1 } from "./support/schemas.ts";

const setup = <S extends AnySchema>(source: S) => {
  const memory = makeMemoryAdapter(source);
  return { memory, orm: toOrm(source, createSoftForeignKey(source, memory)) };
};

/**
 * `setup`, with every read the engine makes recorded as `kind:table`, so a
 * case can state how much work one write costs.
 */
const setupCountingReads = <S extends AnySchema>(source: S) => {
  const memory = makeMemoryAdapter(source);
  const reads: Array<string> = [];
  const counted: OrmAdapter<never> = {
    ...memory,
    count: (table, options) => {
      reads.push(`count:${table.ormName}`);
      return memory.count(table, options);
    },
    findFirst: (table, options) => {
      reads.push(`findFirst:${table.ormName}`);
      return memory.findFirst(table, options);
    },
    findMany: (table, options) => {
      reads.push(`findMany:${table.ormName}`);
      return memory.findMany(table, options);
    },
  };
  return { memory, reads, orm: toOrm(source, createSoftForeignKey(source, counted)) };
};

/**
 * Assert the effect fails with the `SqlError` / `ConstraintError` a violation
 * must produce, and return that error. The success value of `effect` becomes
 * the failure of the result, so a write that wrongly succeeds fails the test.
 */
const expectViolation = <A>(
  effect: Effect.Effect<A, OrmError, never>,
): Effect.Effect<SqlError, A> =>
  Effect.map(Effect.flip(effect), (error) => {
    expect(error).toBeInstanceOf(SqlError);
    if (!(error instanceof SqlError)) throw error;
    expect(error.reason._tag).toBe("ConstraintError");
    expect(error.message).toContain("foreign constraint failed");
    return error;
  });

// owners.code is referenced by guards.ownerCode, both actions RESTRICT.
const restrictSchema = schema({
  version: "1.0.0",
  tables: {
    owners: table("owners", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      code: column("code", Schema.String.check(Schema.isMaxLength(255))).unique(),
    }),
    guards: table("guards", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      ownerCode: column("owner_code", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))),
    }),
  },
  relations: {
    guards: ({ one }) => ({
      owner: one("owners", ["ownerCode", "code"]).foreignKey({
        onUpdate: "RESTRICT",
        onDelete: "RESTRICT",
      }),
    }),
  },
});

// owners.code is referenced by notes.ownerCode, both actions SET NULL.
const setNullSchema = schema({
  version: "1.0.0",
  tables: {
    owners: table("owners", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      code: column("code", Schema.String.check(Schema.isMaxLength(255))).unique(),
    }),
    notes: table("notes", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      ownerCode: column("owner_code", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))),
    }),
  },
  relations: {
    notes: ({ one }) => ({
      owner: one("owners", ["ownerCode", "code"]).foreignKey({
        onUpdate: "SET NULL",
        onDelete: "SET NULL",
      }),
    }),
  },
});

// A two column foreign key against a composite unique constraint.
const compositeSchema = schema({
  version: "1.0.0",
  tables: {
    parents: table("parents", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      tenant: column("tenant", Schema.String.check(Schema.isMaxLength(255))),
      code: column("code", Schema.String.check(Schema.isMaxLength(255))),
    }).unique("parents_tenant_code_uk", ["tenant", "code"]),
    children: table("children", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      tenant: column("tenant", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))),
      code: column("code", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))),
    }),
  },
  relations: {
    children: ({ one }) => ({
      parent: one("parents", ["tenant", "tenant"], ["code", "code"]).foreignKey({
        onUpdate: "RESTRICT",
        onDelete: "CASCADE",
      }),
    }),
  },
});

// No foreign key anywhere: every operation must pass straight through.
const soloSchema = schema({
  version: "1.0.0",
  tables: {
    logs: table("logs", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      text: column("text", Schema.String).default("empty"),
    }),
  },
});

// Mixed column types, for the condition evaluation of the in-memory adapter.
const valuesSchema = schema({
  version: "1.0.0",
  tables: {
    items: table("items", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      label: column("label", Schema.NullOr(Schema.String)),
      score: column("score", Schema.NullOr(Schema.Int)),
      flag: column("flag", Schema.NullOr(Schema.Boolean)),
    }),
  },
});

// a.x references b.y and b.y references a.x, both CASCADE: a foreign key cycle.
const cycleSchema = schema({
  version: "1.0.0",
  tables: {
    a: table("a", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      x: column("x", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))).unique(),
    }),
    b: table("b", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      y: column("y", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))).unique(),
    }),
  },
  relations: {
    a: ({ one }) => ({
      toB: one("b", ["x", "y"]).foreignKey({
        name: "a_b_fk",
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      }),
    }),
    b: ({ one }) => ({
      toA: one("a", ["y", "x"]).foreignKey({
        name: "b_a_fk",
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      }),
    }),
  },
});

// Three levels: heads <- middles (SET NULL) <- tails (CASCADE on update).
const chainSchema = schema({
  version: "1.0.0",
  tables: {
    heads: table("heads", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      code: column("code", Schema.String.check(Schema.isMaxLength(255))).unique(),
    }),
    middles: table("middles", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      code: column("code", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))).unique(),
    }),
    tails: table("tails", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      code: column("code", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))),
    }),
  },
  relations: {
    middles: ({ one }) => ({
      head: one("heads", ["code", "code"]).foreignKey({
        onUpdate: "SET NULL",
        onDelete: "SET NULL",
      }),
    }),
    tails: ({ one }) => ({
      middle: one("middles", ["code", "code"]).foreignKey({
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      }),
    }),
  },
});

// Three levels where the deepest key restricts: heads <- middles (CASCADE) <- tails (RESTRICT).
const restrictChainSchema = schema({
  version: "1.0.0",
  tables: {
    heads: table("heads", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      code: column("code", Schema.String.check(Schema.isMaxLength(255))).unique(),
    }),
    middles: table("middles", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      code: column("code", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))).unique(),
    }),
    tails: table("tails", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      code: column("code", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))),
    }),
  },
  relations: {
    middles: ({ one }) => ({
      head: one("heads", ["code", "code"]).foreignKey({ onUpdate: "CASCADE", onDelete: "CASCADE" }),
    }),
    tails: ({ one }) => ({
      middle: one("middles", ["code", "code"]).foreignKey({
        name: "tails_middles_fk",
        onUpdate: "RESTRICT",
        onDelete: "RESTRICT",
      }),
    }),
  },
});

// Two foreign keys from the same table to the same referenced column.
const twoKeysSchema = schema({
  version: "1.0.0",
  tables: {
    hosts: table("hosts", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      code: column("code", Schema.String.check(Schema.isMaxLength(255))).unique(),
    }),
    pairs: table("pairs", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      left: column("left_code", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))),
      right: column("right_code", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))),
    }),
  },
  relations: {
    pairs: ({ one }) => ({
      leftHost: one("hosts", ["left", "code"]).foreignKey({
        name: "pairs_left_fk",
        onUpdate: "CASCADE",
      }),
      rightHost: one("hosts", ["right", "code"]).foreignKey({
        name: "pairs_right_fk",
        onUpdate: "CASCADE",
      }),
    }),
  },
});

describe("insert", () => {
  it.effect("fails when the referenced row does not exist", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(relationsV1);
      yield* expectViolation(orm.create("posts", { id: "p1", authorId: "ghost" }));
      expect(memory.dump("posts")).toEqual([]);
    }),
  );

  it.effect("succeeds when the referenced row exists, and applies defaults first", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(relationsV1);
      yield* orm.create("users", { id: "u1", name: "one" });
      const post = yield* orm.create("posts", { id: "p1", authorId: "u1" });
      // the engine generated the default before it checked the foreign keys
      expect(post.content).toBe("default content.");
      expect(memory.dump("posts")).toHaveLength(1);
    }),
  );

  it.effect("generates the id default before checking, so a self reference can be found", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(relationsV1);
      yield* orm.create("users", { id: "u1", name: "one" });
      const post = yield* orm.create("posts", { authorId: "u1" });
      expect(typeof post.id).toBe("string");
      expect(memory.dump("posts")[0]?.id).toBe(post.id);
    }),
  );

  it.effect("ignores NULL foreign key values", () =>
    Effect.gen(function* () {
      const { orm } = setup(relationsV1);
      yield* orm.create("users", { id: "u1", name: "one" });
      // relyTo is NULL, so the self-referencing key is not checked
      yield* orm.create("posts", { id: "p1", authorId: "u1", relyTo: null, attachmentUrl: null });
      expect(yield* orm.count("posts")).toBe(1);
    }),
  );

  it.effect("accepts a self reference to a row created earlier in the same batch", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(relationsV1);
      yield* orm.create("users", { id: "u1", name: "one" });
      yield* orm.createMany("posts", [
        { id: "p1", authorId: "u1" },
        { id: "p2", authorId: "u1", relyTo: "p1" },
      ]);
      expect(memory.dump("posts")).toHaveLength(2);
    }),
  );

  it.effect("rejects a self reference to a row created later in the same batch", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(relationsV1);
      yield* orm.create("users", { id: "u1", name: "one" });
      yield* expectViolation(
        orm.createMany("posts", [
          { id: "p2", authorId: "u1", relyTo: "p1" },
          { id: "p1", authorId: "u1" },
        ]),
      );
      expect(memory.dump("posts")).toEqual([]);
    }),
  );

  it.effect("checks a duplicated reference only once", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(relationsV1);
      yield* orm.create("users", { id: "u1", name: "one" });
      yield* orm.createMany("posts", [
        { id: "p1", authorId: "u1" },
        { id: "p2", authorId: "u1" },
        { id: "p3", authorId: "u1" },
      ]);
      expect(memory.dump("posts")).toHaveLength(3);
    }),
  );

  it.effect("rejects a dangling self reference", () =>
    Effect.gen(function* () {
      const { orm } = setup(relationsV1);
      yield* orm.create("users", { id: "u1", name: "one" });
      yield* expectViolation(orm.create("posts", { id: "p1", authorId: "u1", relyTo: "ghost" }));
      expect(yield* orm.count("posts")).toBe(0);
    }),
  );
});

describe("composite foreign key", () => {
  const seed = Effect.fnUntraced(function* (
    orm: ReturnType<typeof setup<typeof compositeSchema>>["orm"],
  ) {
    yield* orm.create("parents", { id: "parent1", tenant: "t1", code: "c1" });
  });

  it.effect("accepts a complete match", () =>
    Effect.gen(function* () {
      const { orm } = setup(compositeSchema);
      yield* seed(orm);
      yield* orm.create("children", { id: "child1", tenant: "t1", code: "c1" });
      expect(yield* orm.count("children")).toBe(1);
    }),
  );

  it.effect("rejects a partial match", () =>
    Effect.gen(function* () {
      const { orm } = setup(compositeSchema);
      yield* seed(orm);
      yield* expectViolation(orm.create("children", { id: "child1", tenant: "t1", code: "other" }));
      expect(yield* orm.count("children")).toBe(0);
    }),
  );

  it.effect("ignores the key when one column is NULL", () =>
    Effect.gen(function* () {
      const { orm } = setup(compositeSchema);
      yield* seed(orm);
      yield* orm.create("children", { id: "child1", tenant: null, code: "other" });
      expect(yield* orm.count("children")).toBe(1);
    }),
  );

  it.effect("cascades a delete on both columns", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(compositeSchema);
      yield* seed(orm);
      yield* orm.create("parents", { id: "parent2", tenant: "t2", code: "c2" });
      yield* orm.createMany("children", [
        { id: "child1", tenant: "t1", code: "c1" },
        { id: "child2", tenant: "t2", code: "c2" },
      ]);
      yield* orm.deleteMany("parents", { where: (b) => b("id", "=", "parent1") });
      expect(memory.dump("children").map((row) => row["id"])).toEqual(["child2"]);
      expect(memory.dump("parents").map((row) => row["id"])).toEqual(["parent2"]);
    }),
  );

  it.effect("restricts an update of one referenced column", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(compositeSchema);
      yield* seed(orm);
      yield* orm.create("children", { id: "child1", tenant: "t1", code: "c1" });
      yield* expectViolation(
        orm.updateMany("parents", {
          where: (b) => b("id", "=", "parent1"),
          set: { code: "c9" },
        }),
      );
      expect(memory.dump("parents")[0]?.["code"]).toBe("c1");
    }),
  );
});

describe("delete", () => {
  it.effect("RESTRICT fails and rolls the cascade back", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(relationsV1);
      yield* orm.createMany("users", [
        { id: "u1", name: "one" },
        { id: "u2", name: "two" },
      ]);
      yield* orm.create("posts", { id: "p1", authorId: "u1", attachmentUrl: "a1" });
      yield* orm.create("attachments", { id: "att1", url: "a1" });
      // likes -> posts is RESTRICT, and it is checked after attachments have cascaded
      yield* orm.create("likes", { id: "l1", userId: "u2", postId: "p1" });

      yield* expectViolation(orm.deleteMany("users", { where: (b) => b("id", "=", "u1") }));

      expect(memory.dump("users")).toHaveLength(2);
      expect(memory.dump("posts")).toHaveLength(1);
      // the cascaded delete of the attachment was rolled back
      expect(memory.dump("attachments")).toHaveLength(1);
      expect(memory.dump("likes")).toHaveLength(1);
    }),
  );

  it.effect("RESTRICT fails on a self-referencing key", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(relationsV1);
      yield* orm.create("users", { id: "u1", name: "one" });
      yield* orm.createMany("posts", [
        { id: "p1", authorId: "u1" },
        { id: "p2", authorId: "u1", relyTo: "p1" },
      ]);
      yield* expectViolation(orm.deleteMany("posts", { where: (b) => b("id", "=", "p1") }));
      expect(memory.dump("posts")).toHaveLength(2);
    }),
  );

  it.effect("CASCADE removes children and grandchildren", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(relationsV1);
      yield* orm.createMany("users", [
        { id: "u1", name: "one" },
        { id: "u2", name: "two" },
      ]);
      yield* orm.createMany("posts", [
        { id: "p1", authorId: "u1", attachmentUrl: "a1" },
        { id: "p2", authorId: "u1", attachmentUrl: "a2" },
        { id: "p3", authorId: "u2", attachmentUrl: "a3" },
      ]);
      yield* orm.createMany("attachments", [
        { id: "att1", url: "a1" },
        { id: "att2", url: "a2" },
        { id: "att3", url: "a3" },
      ]);

      yield* orm.deleteMany("users", { where: (b) => b("id", "=", "u1") });

      expect(memory.dump("users").map((row) => row["id"])).toEqual(["u2"]);
      expect(memory.dump("posts").map((row) => row["id"])).toEqual(["p3"]);
      // attachments are a grandchild of users, through posts
      expect(memory.dump("attachments").map((row) => row["id"])).toEqual(["att3"]);
    }),
  );

  it.effect("SET NULL clears the referencing columns", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(setNullSchema);
      yield* orm.create("owners", { id: "o1", code: "c1" });
      yield* orm.create("owners", { id: "o2", code: "c2" });
      yield* orm.createMany("notes", [
        { id: "n1", ownerCode: "c1" },
        { id: "n2", ownerCode: "c2" },
      ]);

      yield* orm.deleteMany("owners", { where: (b) => b("id", "=", "o1") });

      expect(memory.dump("owners").map((row) => row["id"])).toEqual(["o2"]);
      expect(memory.dump("notes")).toEqual([
        { id: "n1", ownerCode: null },
        { id: "n2", ownerCode: "c2" },
      ]);
    }),
  );

  it.effect("RESTRICT reports the violated key and changes nothing", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(restrictSchema);
      yield* orm.create("owners", { id: "o1", code: "c1" });
      yield* orm.create("guards", { id: "g1", ownerCode: "c1" });

      const error = yield* expectViolation(
        orm.deleteMany("owners", { where: (b) => b("id", "=", "o1") }),
      );
      expect(error.reason.message).toContain("guards_owners_owner_fk");
      expect(error.reason.operation).toBe("delete");
      expect(memory.dump("owners")).toHaveLength(1);
    }),
  );

  it.effect("ignores rows whose foreign key value is NULL", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(restrictSchema);
      yield* orm.create("owners", { id: "o1", code: "c1" });
      yield* orm.create("guards", { id: "g1", ownerCode: null });
      yield* orm.deleteMany("owners", { where: (b) => b("id", "=", "o1") });
      expect(memory.dump("owners")).toEqual([]);
      expect(memory.dump("guards")).toHaveLength(1);
    }),
  );
});

describe("update", () => {
  it.effect("CASCADE propagates the new value to the referencing rows", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(relationsV1);
      yield* orm.create("users", { id: "u1", name: "one" });
      yield* orm.createMany("posts", [
        { id: "p1", authorId: "u1", attachmentUrl: "a1" },
        { id: "p2", authorId: "u1", attachmentUrl: "a2" },
      ]);
      yield* orm.createMany("attachments", [
        { id: "att1", url: "a1" },
        { id: "att2", url: "a2" },
      ]);

      yield* orm.updateMany("posts", {
        where: (b) => b("id", "=", "p1"),
        set: { attachmentUrl: "moved" },
      });

      expect(memory.dump("posts").map((row) => row["attachmentUrl"])).toEqual(["moved", "a2"]);
      expect(memory.dump("attachments").map((row) => row["url"])).toEqual(["moved", "a2"]);
    }),
  );

  it.effect("RESTRICT fails and changes nothing", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(restrictSchema);
      yield* orm.create("owners", { id: "o1", code: "c1" });
      yield* orm.create("guards", { id: "g1", ownerCode: "c1" });

      const error = yield* expectViolation(
        orm.updateMany("owners", {
          where: (b) => b("id", "=", "o1"),
          set: { code: "c9" },
        }),
      );
      expect(error.reason.operation).toBe("update");
      expect(memory.dump("owners")[0]?.["code"]).toBe("c1");
      expect(memory.dump("guards")[0]?.["ownerCode"]).toBe("c1");
    }),
  );

  it.effect("SET NULL clears the referencing columns", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(setNullSchema);
      yield* orm.create("owners", { id: "o1", code: "c1" });
      yield* orm.create("notes", { id: "n1", ownerCode: "c1" });

      yield* orm.updateMany("owners", { where: (b) => b("id", "=", "o1"), set: { code: "c9" } });

      expect(memory.dump("owners")[0]?.["code"]).toBe("c9");
      expect(memory.dump("notes")[0]?.["ownerCode"]).toBe(null);
    }),
  );

  it.effect("does nothing when the update does not touch a referenced column", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(relationsV1);
      yield* orm.create("users", { id: "u1", name: "one" });
      yield* orm.create("posts", { id: "p1", authorId: "u1", attachmentUrl: "a1" });
      yield* orm.create("attachments", { id: "att1", url: "a1" });

      yield* orm.updateMany("posts", {
        where: (b) => b("id", "=", "p1"),
        set: { content: "edited" },
      });

      expect(memory.dump("posts")[0]?.["content"]).toBe("edited");
      expect(memory.dump("attachments")[0]?.["url"]).toBe("a1");
    }),
  );

  it.effect("ignores rows whose referenced value is NULL", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(restrictSchema);
      yield* orm.create("owners", { id: "o1", code: "c1" });
      yield* orm.create("guards", { id: "g1", ownerCode: null });
      yield* orm.updateMany("owners", { where: (b) => b("id", "=", "o1"), set: { code: "c9" } });
      expect(memory.dump("owners")[0]?.["code"]).toBe("c9");
      expect(memory.dump("guards")[0]?.["ownerCode"]).toBe(null);
    }),
  );

  // `guards` owns a foreign key and nothing references it, which is the case
  // the engine used to hand straight to the adapter unchecked.
  it.effect("rejects setting the row's own foreign key to a missing parent", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(restrictSchema);
      yield* orm.create("owners", { id: "o1", code: "c1" });
      yield* orm.create("guards", { id: "g1", ownerCode: "c1" });

      const error = yield* expectViolation(
        orm.updateMany("guards", {
          where: (b) => b("id", "=", "g1"),
          set: { ownerCode: "does-not-exist" },
        }),
      );
      expect(error.reason.message).toContain("guards_owners_owner_fk");
      expect(error.reason.operation).toBe("update");
      expect(memory.dump("guards")[0]?.["ownerCode"]).toBe("c1");
    }),
  );

  it.effect("accepts setting the row's own foreign key to an existing parent", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(restrictSchema);
      yield* orm.createMany("owners", [
        { id: "o1", code: "c1" },
        { id: "o2", code: "c2" },
      ]);
      yield* orm.create("guards", { id: "g1", ownerCode: "c1" });

      yield* orm.updateMany("guards", {
        where: (b) => b("id", "=", "g1"),
        set: { ownerCode: "c2" },
      });

      expect(memory.dump("guards")[0]?.["ownerCode"]).toBe("c2");
    }),
  );

  it.effect("clearing the row's own foreign key to NULL is allowed", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(restrictSchema);
      yield* orm.create("owners", { id: "o1", code: "c1" });
      yield* orm.create("guards", { id: "g1", ownerCode: "c1" });

      yield* orm.updateMany("guards", {
        where: (b) => b("id", "=", "g1"),
        set: { ownerCode: null },
      });

      expect(memory.dump("guards")[0]?.["ownerCode"]).toBe(null);
    }),
  );

  // The referenced table owns a key as well, so the check must not run before
  // the cascade that creates the row it looks for.
  it.effect("still cascades when the updated table owns a foreign key too", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(relationsV1);
      yield* orm.create("users", { id: "u1", name: "one" });
      yield* orm.create("posts", { id: "p1", authorId: "u1", attachmentUrl: "a1" });
      yield* orm.create("attachments", { id: "att1", url: "a1" });

      yield* orm.updateMany("posts", {
        where: (b) => b("id", "=", "p1"),
        set: { attachmentUrl: "moved" },
      });

      expect(memory.dump("attachments")[0]?.["url"]).toBe("moved");
    }),
  );

  // The `set` holds a constant, so the work of the check must not grow with
  // the number of rows the update matches.
  it.effect("checks a constant foreign key with one parent lookup", () =>
    Effect.gen(function* () {
      const { memory, orm, reads } = setupCountingReads(restrictSchema);
      yield* orm.createMany("owners", [
        { id: "o1", code: "c1" },
        { id: "o2", code: "c2" },
      ]);
      yield* orm.createMany("guards", [
        { id: "g1", ownerCode: "c1" },
        { id: "g2", ownerCode: "c1" },
        { id: "g3", ownerCode: "c1" },
      ]);
      reads.length = 0;

      yield* orm.updateMany("guards", {
        where: (b) => b("ownerCode", "=", "c1"),
        set: { ownerCode: "c2" },
      });

      // one bounded read to see the update matches a row, one parent lookup
      expect(reads).toEqual(["findFirst:guards", "findFirst:owners"]);
      expect(memory.dump("guards").map((row) => row["ownerCode"])).toEqual(["c2", "c2", "c2"]);
    }),
  );

  it.effect("checks nothing when the update matches no row", () =>
    Effect.gen(function* () {
      const { orm, reads } = setupCountingReads(restrictSchema);
      yield* orm.create("owners", { id: "o1", code: "c1" });
      reads.length = 0;

      yield* orm.updateMany("guards", {
        where: (b) => b("id", "=", "missing"),
        set: { ownerCode: "does-not-exist" },
      });

      expect(reads).toEqual(["findFirst:guards"]);
    }),
  );

  // A key the `set` writes only in part keeps one column of each row, so the
  // rows are still read and checked.
  it.effect("checks a key the update writes only in part", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(compositeSchema);
      yield* orm.create("parents", { id: "parent1", tenant: "t1", code: "c1" });
      yield* orm.create("children", { id: "child1", tenant: "t1", code: "c1" });

      yield* expectViolation(
        orm.updateMany("children", {
          where: (b) => b("id", "=", "child1"),
          set: { code: "c9" },
        }),
      );
      expect(memory.dump("children")[0]?.["code"]).toBe("c1");

      yield* orm.create("parents", { id: "parent2", tenant: "t1", code: "c2" });
      yield* orm.updateMany("children", {
        where: (b) => b("id", "=", "child1"),
        set: { code: "c2" },
      });
      expect(memory.dump("children")[0]?.["code"]).toBe("c2");
    }),
  );
});

describe("upsert", () => {
  it.effect("creates, then updates, through the engine", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(relationsV1);
      yield* orm.create("users", { id: "u1", name: "one" });

      const created = yield* orm.upsert("posts", {
        where: (b) => b("id", "=", "p1"),
        create: { id: "p1", authorId: "u1", content: "first" },
        update: { content: "second" },
        returning: true,
      });
      expect(created.content).toBe("first");

      const updated = yield* orm.upsert("posts", {
        where: (b) => b("id", "=", "p1"),
        create: { id: "p1", authorId: "u1", content: "first" },
        update: { content: "second" },
        returning: true,
      });
      expect(updated.content).toBe("second");
      expect(memory.dump("posts")).toHaveLength(1);
    }),
  );

  it.effect("checks the foreign keys of the row it updates", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(restrictSchema);
      yield* orm.create("owners", { id: "o1", code: "c1" });
      yield* orm.create("guards", { id: "g1", ownerCode: "c1" });

      const error = yield* expectViolation(
        orm.upsert("guards", {
          where: (b) => b("id", "=", "g1"),
          create: { id: "g1", ownerCode: "c1" },
          update: { ownerCode: "does-not-exist" },
        }),
      );
      expect(error.reason.operation).toBe("update");
      expect(memory.dump("guards")[0]?.["ownerCode"]).toBe("c1");
    }),
  );

  it.effect("checks the foreign keys of the row it creates", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(relationsV1);
      yield* expectViolation(
        orm.upsert("posts", {
          where: (b) => b("id", "=", "p1"),
          create: { id: "p1", authorId: "ghost" },
          update: { content: "second" },
        }),
      );
      expect(memory.dump("posts")).toEqual([]);
    }),
  );

  it.effect("cascades from the row it updates", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(relationsV1);
      yield* orm.create("users", { id: "u1", name: "one" });
      yield* orm.create("posts", { id: "p1", authorId: "u1", attachmentUrl: "a1" });
      yield* orm.create("attachments", { id: "att1", url: "a1" });

      yield* orm.upsert("posts", {
        where: (b) => b("id", "=", "p1"),
        create: { id: "p1", authorId: "u1" },
        update: { attachmentUrl: "moved" },
      });

      expect(memory.dump("posts")[0]?.["attachmentUrl"]).toBe("moved");
      expect(memory.dump("attachments")[0]?.["url"]).toBe("moved");
    }),
  );

  it.effect("restricts through the row it updates", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(restrictSchema);
      yield* orm.create("owners", { id: "o1", code: "c1" });
      yield* orm.create("guards", { id: "g1", ownerCode: "c1" });

      yield* expectViolation(
        orm.upsert("owners", {
          where: (b) => b("id", "=", "o1"),
          create: { id: "o1", code: "c1" },
          update: { code: "c9" },
        }),
      );
      expect(memory.dump("owners")[0]?.["code"]).toBe("c1");
    }),
  );

  it.effect("creates without returning", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(relationsV1);
      yield* orm.create("users", { id: "u1", name: "one" });
      yield* orm.upsert("posts", {
        where: (b) => b("id", "=", "p1"),
        create: { id: "p1", authorId: "u1", content: "first" },
        update: { content: "second" },
      });
      expect(memory.dump("posts")).toHaveLength(1);
      expect(memory.dump("posts")[0]?.["content"]).toBe("first");
    }),
  );
});

describe("the in-memory adapter", () => {
  const items = Effect.fnUntraced(function* () {
    const { memory, orm } = setup(valuesSchema);
    yield* orm.createMany("items", [
      { id: "i1", label: "hello", score: 10, flag: true },
      { id: "i2", label: "world", score: 5, flag: false },
      { id: "i3", label: null, score: null, flag: null },
    ]);
    const ids = (where: Parameters<typeof orm.findMany<"items">>[1]) =>
      Effect.map(orm.findMany("items", where), (rows) => rows.map((row) => row.id));
    return { memory, orm, ids };
  });

  it.effect("compares values, with UNKNOWN for NULL", () =>
    Effect.gen(function* () {
      const { ids } = yield* items();
      expect(yield* ids({ where: (b) => b("score", "=", 10) })).toEqual(["i1"]);
      expect(yield* ids({ where: (b) => b("score", "!=", 10) })).toEqual(["i2"]);
      expect(yield* ids({ where: (b) => b("score", "=", null) })).toEqual([]);
      expect(yield* ids({ where: (b) => b("score", ">", 5) })).toEqual(["i1"]);
      expect(yield* ids({ where: (b) => b("score", ">=", 5) })).toEqual(["i1", "i2"]);
      expect(yield* ids({ where: (b) => b("score", "<", 10) })).toEqual(["i2"]);
      expect(yield* ids({ where: (b) => b("score", "<=", 10) })).toEqual(["i1", "i2"]);
      expect(yield* ids({ where: (b) => b("flag") })).toEqual(["i1"]);
    }),
  );

  it.effect("handles the null-aware operators", () =>
    Effect.gen(function* () {
      const { ids } = yield* items();
      expect(yield* ids({ where: (b) => b.isNull("score") })).toEqual(["i3"]);
      expect(yield* ids({ where: (b) => b.isNotNull("score") })).toEqual(["i1", "i2"]);
      expect(yield* ids({ where: (b) => b("label", "is", "hello") })).toEqual(["i1"]);
      expect(yield* ids({ where: (b) => b("label", "is not", "hello") })).toEqual(["i2", "i3"]);
    }),
  );

  it.effect("handles the array operators", () =>
    Effect.gen(function* () {
      const { ids } = yield* items();
      expect(yield* ids({ where: (b) => b("score", "in", [5, 10]) })).toEqual(["i1", "i2"]);
      expect(yield* ids({ where: (b) => b("score", "not in", [5]) })).toEqual(["i1"]);
      expect(yield* ids({ where: (b) => b("id", "in", []) })).toEqual([]);
    }),
  );

  it.effect("handles the string operators", () =>
    Effect.gen(function* () {
      const { ids } = yield* items();
      expect(yield* ids({ where: (b) => b("label", "contains", "ell") })).toEqual(["i1"]);
      expect(yield* ids({ where: (b) => b("label", "not contains", "ell") })).toEqual(["i2"]);
      expect(yield* ids({ where: (b) => b("label", "starts with", "wor") })).toEqual(["i2"]);
      expect(yield* ids({ where: (b) => b("label", "not starts with", "wor") })).toEqual(["i1"]);
      expect(yield* ids({ where: (b) => b("label", "ends with", "lo") })).toEqual(["i1"]);
      expect(yield* ids({ where: (b) => b("label", "not ends with", "lo") })).toEqual(["i2"]);
    }),
  );

  it.effect("combines conditions with and / or / not", () =>
    Effect.gen(function* () {
      const { ids } = yield* items();
      expect(yield* ids({ where: (b) => b.and(b.isNotNull("label"), b("score", ">", 5)) })).toEqual(
        ["i1"],
      );
      expect(
        yield* ids({ where: (b) => b.or(b("score", "=", 5), b("label", "=", "hello")) }),
      ).toEqual(["i1", "i2"]);
      // NOT UNKNOWN stays UNKNOWN, so the NULL row does not match
      expect(yield* ids({ where: (b) => b.not(b("score", "=", 10)) })).toEqual(["i2"]);
      expect(yield* ids({ where: (b) => b.and(b.isNull("score"), b("score", ">", 1)) })).toEqual(
        [],
      );
      expect(yield* ids({ where: (b) => b.or(b.isNull("score"), b("score", ">", 1)) })).toEqual([
        "i1",
        "i2",
        "i3",
      ]);
    }),
  );

  it.effect("applies select, orderBy, limit, and offset", () =>
    Effect.gen(function* () {
      const { orm } = yield* items();
      const rows = yield* orm.findMany("items", {
        select: ["id", "score"],
        where: (b) => b.isNotNull("score"),
        orderBy: ["score", "desc"],
      });
      expect(rows).toEqual([
        { id: "i1", score: 10 },
        { id: "i2", score: 5 },
      ]);
      expect(
        yield* orm.findMany("items", { orderBy: ["score", "asc"], limit: 1, offset: 1 }),
      ).toHaveLength(1);
      expect(yield* orm.count("items", { where: (b) => b.isNotNull("score") })).toBe(2);
      expect(yield* orm.findFirst("items", { where: (b) => b("id", "=", "nope") })).toBe(null);
    }),
  );

  it.effect("can seed and clear the store directly", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(restrictSchema);
      memory.seed("owners", [{ id: "o1", code: "c1" }]);
      memory.seed("guards", [{ id: "g1", ownerCode: "c1" }]);
      // the engine reads what was planted, so the key is still enforced
      yield* expectViolation(orm.deleteMany("owners", { where: (b) => b("id", "=", "o1") }));
      memory.clear();
      expect(memory.dump("owners")).toEqual([]);
      expect(memory.dump("guards")).toEqual([]);
    }),
  );
});

describe("cascades through several levels", () => {
  it.effect("a CASCADE cycle on update terminates and writes both sides", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(cycleSchema);
      memory.seed("a", [{ id: "a1", x: "k" }]);
      memory.seed("b", [{ id: "b1", y: "k" }]);

      yield* orm.updateMany("a", { where: (b) => b("id", "=", "a1"), set: { x: "k2" } });

      expect(memory.dump("a")).toEqual([{ id: "a1", x: "k2" }]);
      expect(memory.dump("b")).toEqual([{ id: "b1", y: "k2" }]);
    }),
  );

  it.effect("a CASCADE cycle on delete terminates and removes both sides", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(cycleSchema);
      memory.seed("a", [{ id: "a1", x: "k" }]);
      memory.seed("b", [{ id: "b1", y: "k" }]);

      yield* orm.deleteMany("a", { where: (b) => b("id", "=", "a1") });

      expect(memory.dump("a")).toEqual([]);
      expect(memory.dump("b")).toEqual([]);
    }),
  );

  it.effect("a SET NULL on delete cascades the resulting update to the grandchild", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(chainSchema);
      yield* orm.create("heads", { id: "h1", code: "k" });
      yield* orm.create("middles", { id: "m1", code: "k" });
      yield* orm.create("tails", { id: "t1", code: "k" });

      yield* orm.deleteMany("heads", { where: (b) => b("id", "=", "h1") });

      expect(memory.dump("heads")).toEqual([]);
      // the same change through an update nulls the grandchild, so a delete must too
      expect(memory.dump("middles")).toEqual([{ id: "m1", code: null }]);
      expect(memory.dump("tails")).toEqual([{ id: "t1", code: null }]);
    }),
  );

  it.effect("a CASCADE delete that also removes the restricting row succeeds", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(relationsV1);
      yield* orm.create("users", { id: "u1", name: "one" });
      // p2 relies on p1 through a RESTRICT key, and the cascade removes both
      yield* orm.createMany("posts", [
        { id: "p1", authorId: "u1" },
        { id: "p2", authorId: "u1", relyTo: "p1" },
      ]);

      yield* orm.deleteMany("users", { where: (b) => b("id", "=", "u1") });

      expect(memory.dump("users")).toEqual([]);
      expect(memory.dump("posts")).toEqual([]);
    }),
  );

  it.effect("a CASCADE update that reaches a RESTRICT key fails and changes nothing", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(restrictChainSchema);
      yield* orm.create("heads", { id: "h1", code: "k" });
      yield* orm.create("middles", { id: "m1", code: "k" });
      yield* orm.create("tails", { id: "t1", code: "k" });

      const error = yield* expectViolation(
        orm.updateMany("heads", {
          where: (b) => b("id", "=", "h1"),
          set: { code: "k2" },
        }),
      );

      // the cascade would leave the tail dangling, so the whole update is refused
      expect(error.reason.message).toContain("tails_middles_fk");
      expect(memory.dump("heads")[0]?.["code"]).toBe("k");
      expect(memory.dump("middles")[0]?.["code"]).toBe("k");
      expect(memory.dump("tails")[0]?.["code"]).toBe("k");
    }),
  );

  it.effect("updates the same row once per key when two keys point at it", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(twoKeysSchema);
      yield* orm.create("hosts", { id: "h1", code: "k" });
      yield* orm.create("pairs", { id: "pair1", left: "k", right: "k" });

      yield* orm.updateMany("hosts", { where: (b) => b("id", "=", "h1"), set: { code: "k2" } });

      // the cycle guard must not swallow the second key's cascade
      expect(memory.dump("pairs")).toEqual([{ id: "pair1", left: "k2", right: "k2" }]);
    }),
  );

  it.effect("a RESTRICT key still fails when the referencing row survives", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(restrictChainSchema);
      yield* orm.create("heads", { id: "h1", code: "k" });
      yield* orm.create("middles", { id: "m1", code: "k" });
      yield* orm.create("tails", { id: "t1", code: "k" });

      yield* expectViolation(orm.deleteMany("heads", { where: (b) => b("id", "=", "h1") }));

      expect(memory.dump("heads")).toHaveLength(1);
      expect(memory.dump("middles")).toHaveLength(1);
      expect(memory.dump("tails")).toHaveLength(1);
    }),
  );
});

describe("tables without foreign keys", () => {
  it.effect("pass straight through", () =>
    Effect.gen(function* () {
      const { memory, orm } = setup(soloSchema);
      yield* orm.create("logs", { id: "log1" });
      yield* orm.upsert("logs", {
        where: (b) => b("id", "=", "log1"),
        create: { id: "log1" },
        update: { text: "changed" },
      });
      expect(memory.dump("logs")[0]?.["text"]).toBe("changed");

      yield* orm.updateMany("logs", { where: (b) => b("id", "=", "log1"), set: { text: "again" } });
      expect(memory.dump("logs")[0]?.["text"]).toBe("again");

      yield* orm.deleteMany("logs", { where: (b) => b("id", "=", "log1") });
      expect(memory.dump("logs")).toEqual([]);
    }),
  );
});
