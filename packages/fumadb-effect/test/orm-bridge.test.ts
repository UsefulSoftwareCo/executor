/**
 * `toOrm` (`src/query/orm.ts`, upstream `src/query/orm/index.ts`): the bridge
 * between the typed query interface and an adapter that works on resolved
 * tables and compiled conditions.
 *
 * Every test runs against a fake adapter that records its calls, so the
 * assertions are about the bridge only: table lookup, constant folding of
 * `where`, join compilation, and `orderBy` normalisation.
 */
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { QueryError } from "../src/contracts/errors.ts";
import type { Condition } from "../src/contracts/condition.ts";
import type { OrmError } from "../src/contracts/query.ts";
import type {
  CompiledFindOptions,
  CompiledUpsert,
  OrmAdapter,
  Row,
} from "../src/contracts/query-adapter.ts";
import { toOrm } from "../src/implementation/query/orm.ts";
import type { AnyTable } from "../src/contracts/schema/table.ts";
import { queryV1 } from "./support/schemas.ts";

interface Call {
  readonly method: string;
  readonly table: string;
  readonly options: unknown;
}

const makeAdapter = (options: { readonly upsertResult?: Row | undefined } = {}) => {
  const calls: Array<Call> = [];
  const record = (method: string, table: AnyTable, value: unknown): void => {
    calls.push({ method, table: table.ormName, options: value });
  };
  const adapter: OrmAdapter<never> = {
    tables: queryV1.tables,
    count: (table, value) =>
      Effect.sync(() => {
        record("count", table, value);
        return 7;
      }),
    findFirst: (table, value) =>
      Effect.sync(() => {
        record("findFirst", table, value);
        return { id: "first" };
      }),
    findMany: (table, value) =>
      Effect.sync(() => {
        record("findMany", table, value);
        return [{ id: "many" }];
      }),
    updateMany: (table, value) => Effect.sync(() => record("updateMany", table, value)),
    deleteMany: (table, value) => Effect.sync(() => record("deleteMany", table, value)),
    upsert: (table, value) =>
      Effect.sync(() => {
        record("upsert", table, value);
        return options.upsertResult;
      }),
    create: (table, values) =>
      Effect.sync(() => {
        record("create", table, values);
        return { id: "created" };
      }),
    createMany: (table, values) =>
      Effect.sync(() => {
        record("createMany", table, values);
        return [{ _id: "created" }];
      }),
    transaction: (effect) => effect,
  };
  return { adapter, calls, orm: toOrm(queryV1, adapter) };
};

/** Narrow an ORM failure to `QueryError`; a driver error would fail the test. */
const asQueryError = (error: OrmError): QueryError => {
  if (error instanceof QueryError) return error;
  throw error;
};

const findOptionsOf = (call: Call | undefined): CompiledFindOptions => {
  if (call === undefined) throw new Error("no call was recorded");
  return call.options as CompiledFindOptions;
};

const whereOf = (call: Call | undefined): Condition | undefined => {
  if (call === undefined) throw new Error("no call was recorded");
  return (call.options as { readonly where: Condition | undefined }).where;
};

describe("table resolution", () => {
  it.effect("fails with UnknownTable", () =>
    Effect.gen(function* () {
      const { calls, orm } = makeAdapter();
      const error = asQueryError(yield* Effect.flip(orm.count("nope" as "users")));
      expect(error).toBeInstanceOf(QueryError);
      expect(error.reason).toBe("UnknownTable");
      expect(error.table).toBe("nope");
      expect(error.message).toBe("Invalid table name nope.");
      expect(calls).toEqual([]);
    }),
  );

  it.effect("fails with UnknownTable on every operation", () =>
    Effect.gen(function* () {
      const { calls, orm } = makeAdapter();
      const table = "nope" as "users";
      const reasons = [
        asQueryError(yield* Effect.flip(orm.findMany(table))).reason,
        asQueryError(yield* Effect.flip(orm.findFirst(table, {}))).reason,
        asQueryError(yield* Effect.flip(orm.create(table, { name: "x" }))).reason,
        asQueryError(yield* Effect.flip(orm.createMany(table, []))).reason,
        asQueryError(yield* Effect.flip(orm.updateMany(table, { set: {} }))).reason,
        asQueryError(yield* Effect.flip(orm.deleteMany(table))).reason,
        asQueryError(
          yield* Effect.flip(
            orm.upsert(table, {
              where: (b) => b("id", "=", "x"),
              create: { name: "n" },
              update: {},
            }),
          ),
        ).reason,
      ];
      expect(reasons).toEqual(Array.from({ length: 7 }, () => "UnknownTable"));
      expect(calls).toEqual([]);
    }),
  );
});

describe("a where that can never match", () => {
  const never = () => false as const;

  it.effect("counts zero without calling the adapter", () =>
    Effect.gen(function* () {
      const { calls, orm } = makeAdapter();
      expect(yield* orm.count("users", { where: never })).toBe(0);
      expect(calls).toEqual([]);
    }),
  );

  it.effect("returns an empty list and a null row", () =>
    Effect.gen(function* () {
      const { calls, orm } = makeAdapter();
      expect(yield* orm.findMany("users", { where: never })).toEqual([]);
      expect(yield* orm.findFirst("users", { where: never })).toBeNull();
      expect(calls).toEqual([]);
    }),
  );

  it.effect("skips updateMany and deleteMany", () =>
    Effect.gen(function* () {
      const { calls, orm } = makeAdapter();
      yield* orm.updateMany("users", { where: never, set: { name: "x" } });
      yield* orm.deleteMany("users", { where: never });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("skips upsert, and fails when the row was requested", () =>
    Effect.gen(function* () {
      const { calls, orm } = makeAdapter();
      yield* orm.upsert("users", { where: never, create: { name: "a" }, update: { name: "b" } });
      expect(calls).toEqual([]);

      const error = asQueryError(
        yield* Effect.flip(
          orm.upsert("users", {
            where: never,
            create: { name: "a" },
            update: { name: "b" },
            returning: true,
          }),
        ),
      );
      expect(error).toBeInstanceOf(QueryError);
      expect(error.reason).toBe("NoMatchingRow");
      expect(error.table).toBe("users");
      expect(calls).toEqual([]);
    }),
  );

  it.effect("folds a builder expression that reduces to false", () =>
    Effect.gen(function* () {
      const { calls, orm } = makeAdapter();
      expect(yield* orm.count("users", { where: (b) => b.and(b("id", "=", "x"), b.or()) })).toBe(0);
      expect(calls).toEqual([]);
    }),
  );
});

describe("where compilation", () => {
  it.effect("passes no condition when there is no where", () =>
    Effect.gen(function* () {
      const { calls, orm } = makeAdapter();
      expect(yield* orm.count("users")).toBe(7);
      expect(whereOf(calls[0])).toBeUndefined();
    }),
  );

  it.effect("folds a where that always matches to no condition", () =>
    Effect.gen(function* () {
      const { calls, orm } = makeAdapter();
      yield* orm.deleteMany("users", { where: (b) => b.and() });
      expect(calls).toHaveLength(1);
      expect(whereOf(calls[0])).toBeUndefined();
    }),
  );

  it.effect("passes the compiled condition through", () =>
    Effect.gen(function* () {
      const { calls, orm } = makeAdapter();
      yield* orm.updateMany("users", { where: (b) => b("name", "=", "bob"), set: { name: "rob" } });
      const condition = whereOf(calls[0]);
      if (condition === undefined || condition._tag !== "Compare")
        throw new Error("expected a Compare condition");
      expect(condition.column === queryV1.tables.users.columns.name).toBe(true);
      expect(condition.value).toBe("bob");
      const first = calls[0];
      if (first === undefined) throw new Error("expected one adapter call");
      expect((first.options as { readonly set: Row }).set).toEqual({ name: "rob" });
    }),
  );

  it.effect("reports an unknown column as a typed failure, not a defect", () =>
    Effect.gen(function* () {
      const { orm } = makeAdapter();
      const error = asQueryError(
        yield* Effect.flip(orm.findMany("users", { where: (b) => b("nope" as "name", "=", "x") })),
      );
      expect(error).toBeInstanceOf(QueryError);
      expect(error.reason).toBe("UnknownColumn");
      expect(error.column).toBe("nope");
    }),
  );
});

describe("find options", () => {
  it.effect("passes select, limit, and offset through and defaults select to true", () =>
    Effect.gen(function* () {
      const { calls, orm } = makeAdapter();
      yield* orm.findMany("users");
      expect(findOptionsOf(calls[0])).toEqual({
        select: true,
        where: undefined,
        orderBy: undefined,
        join: undefined,
        limit: undefined,
        offset: undefined,
      });

      yield* orm.findMany("users", { select: ["name"], limit: 5, offset: 10 });
      const options = findOptionsOf(calls[1]);
      expect(options.select).toEqual(["name"]);
      expect(options.limit).toBe(5);
      expect(options.offset).toBe(10);
    }),
  );

  it.effect("accepts orderBy as a single tuple or an array of tuples", () =>
    Effect.gen(function* () {
      const { calls, orm } = makeAdapter();
      yield* orm.findMany("users", { orderBy: ["name", "asc"] });
      expect(findOptionsOf(calls[0]).orderBy).toEqual([[queryV1.tables.users.columns.name, "asc"]]);

      yield* orm.findMany("users", {
        orderBy: [
          ["name", "asc"],
          ["id", "desc"],
        ],
      });
      const orderBy = findOptionsOf(calls[1]).orderBy;
      expect(orderBy).toHaveLength(2);
      expect(orderBy?.[0]?.[0] === queryV1.tables.users.columns.name).toBe(true);
      expect(orderBy?.[0]?.[1]).toBe("asc");
      expect(orderBy?.[1]?.[0] === queryV1.tables.users.columns.id).toBe(true);
      expect(orderBy?.[1]?.[1]).toBe("desc");
    }),
  );

  it.effect("drops an empty orderBy", () =>
    Effect.gen(function* () {
      const { calls, orm } = makeAdapter();
      yield* orm.findMany("users", { orderBy: [] });
      expect(findOptionsOf(calls[0]).orderBy).toBeUndefined();
    }),
  );

  it.effect("fails on an unknown orderBy column", () =>
    Effect.gen(function* () {
      const { orm } = makeAdapter();
      const error = asQueryError(
        yield* Effect.flip(orm.findMany("users", { orderBy: ["nope" as "name", "asc"] })),
      );
      expect(error.reason).toBe("UnknownColumn");
      expect(error.table).toBe("users");
      expect(error.column).toBe("nope");
    }),
  );
});

describe("join compilation", () => {
  it.effect("compiles one entry per joined relation", () =>
    Effect.gen(function* () {
      const { calls, orm } = makeAdapter();
      yield* orm.findMany("users", { join: (b) => b.messages({ limit: 2, select: ["content"] }) });

      const join = findOptionsOf(calls[0]).join;
      expect(join).toHaveLength(1);
      const entry = join?.[0];
      expect(entry?.relation === queryV1.tables.users.relations.messages).toBe(true);
      expect(entry?.options).not.toBe(false);
      if (entry === undefined || entry.options === false) throw new Error("unreachable");
      expect(entry.options.limit).toBe(2);
      expect(entry.options.select).toEqual(["content"]);
    }),
  );

  it.effect("compiles the joined table's own where and orderBy", () =>
    Effect.gen(function* () {
      const { calls, orm } = makeAdapter();
      yield* orm.findMany("users", {
        join: (b) =>
          b.messages({
            where: (mb) => mb("content", "contains", "hi"),
            orderBy: ["content", "desc"],
          }),
      });
      const entry = findOptionsOf(calls[0]).join?.[0];
      if (entry === undefined || entry.options === false) throw new Error("unreachable");
      const condition = entry.options.where;
      if (condition === undefined || condition._tag !== "Compare")
        throw new Error("expected a Compare condition");
      expect(condition.column === queryV1.tables.messages.columns.content).toBe(true);
      expect(condition.operator).toBe("contains");
      expect(entry.options.orderBy?.[0]?.[0] === queryV1.tables.messages.columns.content).toBe(
        true,
      );
    }),
  );

  it.effect("marks a joined relation whose where can never match", () =>
    Effect.gen(function* () {
      const { calls, orm } = makeAdapter();
      yield* orm.findMany("users", { join: (b) => b.messages({ where: () => false }) });
      expect(findOptionsOf(calls[0]).join?.[0]?.options).toBe(false);
    }),
  );

  it.effect("compiles nested joins", () =>
    Effect.gen(function* () {
      const { calls, orm } = makeAdapter();
      yield* orm.findMany("users", { join: (b) => b.messages({ join: (mb) => mb.author() }) });

      const entry = findOptionsOf(calls[0]).join?.[0];
      if (entry === undefined || entry.options === false) throw new Error("unreachable");
      const nested = entry.options.join?.[0];
      expect(nested?.relation === queryV1.tables.messages.relations.author).toBe(true);
      if (nested === undefined || nested.options === false) throw new Error("unreachable");
      expect(nested.options.select).toBe(true);
    }),
  );

  it.effect("keeps the order the relations were joined in", () =>
    Effect.gen(function* () {
      const { calls, orm } = makeAdapter();
      yield* orm.findFirst("messages", { join: (b) => b.mentioning().author() });
      const join = findOptionsOf(calls[0]).join;
      expect(join?.map((entry) => entry.relation.name)).toEqual(["mentioning", "author"]);
    }),
  );

  it.effect("passes no join when there is none", () =>
    Effect.gen(function* () {
      const { calls, orm } = makeAdapter();
      yield* orm.findMany("users", { limit: 1 });
      expect(findOptionsOf(calls[0]).join).toBeUndefined();
    }),
  );
});

describe("upsert", () => {
  it.effect("forwards create, update, and the returning flag", () =>
    Effect.gen(function* () {
      const { calls, orm } = makeAdapter();
      yield* orm.upsert("users", {
        where: (b) => b("id", "=", "one"),
        create: { id: "one", name: "a" },
        update: { name: "b" },
      });
      const options = calls[0]?.options as CompiledUpsert;
      expect(options.create).toEqual({ id: "one", name: "a" });
      expect(options.update).toEqual({ name: "b" });
      expect(options.returning).toBe(false);
      expect(options.where?._tag).toBe("Compare");
    }),
  );

  it.effect("returns the adapter's row when returning is requested", () =>
    Effect.gen(function* () {
      const { calls, orm } = makeAdapter({ upsertResult: { id: "one", name: "a" } });
      const row = yield* orm.upsert("users", {
        where: (b) => b("id", "=", "one"),
        create: { id: "one", name: "a" },
        update: { name: "b" },
        returning: true,
      });
      expect(row).toEqual({ id: "one", name: "a" });
      const first = calls[0];
      if (first === undefined) throw new Error("expected one adapter call");
      expect((first.options as CompiledUpsert).returning).toBe(true);
    }),
  );

  it.effect("fails when the adapter returns nothing but a row was requested", () =>
    Effect.gen(function* () {
      const { orm } = makeAdapter({ upsertResult: undefined });
      const error = asQueryError(
        yield* Effect.flip(
          orm.upsert("users", {
            where: (b) => b("id", "=", "one"),
            create: { id: "one", name: "a" },
            update: {},
            returning: true,
          }),
        ),
      );
      expect(error.reason).toBe("UnexpectedResult");
      expect(error.table).toBe("users");
    }),
  );

  it.effect("ignores a row the adapter returns when returning was not requested", () =>
    Effect.gen(function* () {
      const { orm } = makeAdapter({ upsertResult: { id: "one" } });
      expect(
        yield* orm.upsert("users", {
          where: (b) => b("id", "=", "one"),
          create: { id: "one", name: "a" },
          update: {},
        }),
      ).toBeUndefined();
    }),
  );
});

describe("pass-through operations", () => {
  it.effect("create and createMany forward their values", () =>
    Effect.gen(function* () {
      const { calls, orm } = makeAdapter();
      expect(yield* orm.create("users", { name: "a" })).toEqual({ id: "created" });
      expect(yield* orm.createMany("users", [{ name: "a" }, { name: "b" }])).toEqual([
        { _id: "created" },
      ]);
      expect(calls.map((call) => call.method)).toEqual(["create", "createMany"]);
      expect(calls[0]?.options).toEqual({ name: "a" });
      expect(calls[1]?.options).toEqual([{ name: "a" }, { name: "b" }]);
    }),
  );

  it.effect("transaction is the adapter's", () =>
    Effect.gen(function* () {
      const { orm } = makeAdapter();
      expect(yield* orm.transaction(Effect.succeed(3))).toBe(3);
    }),
  );

  it("exposes the schema it was built for", () => {
    expect(makeAdapter().orm.schema === queryV1).toBe(true);
  });
});
