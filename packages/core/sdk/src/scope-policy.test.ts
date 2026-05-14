import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { column, idColumn, table } from "fumadb/schema";

import { createExecutor } from "./executor";
import { StorageError } from "./fuma-runtime";
import { ScopeId } from "./ids";
import { definePlugin } from "./plugin";
import { Scope } from "./scope";
import { dateColumn, scopedExecutorTable, textColumn } from "./core-schema";
import { assertExecutorScopeAllowed, type ExecutorScopePolicyContext } from "./scope-policy";
import { makeTestConfig } from "./test-config";

const scope = (id: string) =>
  Scope.make({
    id: ScopeId.make(id),
    name: id,
    createdAt: new Date(),
  });

const innerScope = scope("inner");
const outerScope = scope("outer");

const assertScopePolicyTypes = () => {
  const typedTable = scopedExecutorTable("typed_item", {
    created_at: dateColumn("created_at"),
    value: textColumn("value"),
  });

  typedTable.policy<ExecutorScopePolicyContext>({
    name: "typed.scope.test",
    onCreate: ({ values, context }) => {
      assertExecutorScopeAllowed("typed_item", "write", values.scope_id, context);

      // @ts-expect-error scope guards only accept scope-like string values
      assertExecutorScopeAllowed("typed_item", "write", values.created_at, context);
      // @ts-expect-error policy rows do not expose undeclared table columns
      void values.not_a_column;
    },
    onRead: ({ builder, context }) => {
      const scopeIds = [...context.allowedScopeIds];
      builder("scope_id", "in", scopeIds);
      // @ts-expect-error query guards preserve the selected column value type
      return builder("created_at", "in", scopeIds);
    },
  });
};

void assertScopePolicyTypes;

const leakySchema = {
  leaky_item: scopedExecutorTable("leaky_item", {
    value: textColumn("value"),
  }),
};

interface LeakyRow {
  readonly id: string;
  readonly scope_id: string;
  readonly value: string;
}

const leakyPlugin = definePlugin(() => ({
  id: "leaky" as const,
  schema: leakySchema,
  storage: ({ fuma }) => ({
    create: (row: LeakyRow) => fuma.use("leaky.create", (db) => db.create("leaky_item", row)),
    countAll: () => fuma.use("leaky.countAll", (db) => db.count("leaky_item")),
    deleteAll: () => fuma.use("leaky.deleteAll", (db) => db.deleteMany("leaky_item", {})),
    moveAll: (scopeId: string) =>
      fuma.use("leaky.moveAll", (db) =>
        db.updateMany("leaky_item", { set: { scope_id: scopeId } }),
      ),
    readAll: () =>
      fuma.use("leaky.readAll", (db) =>
        db.findMany("leaky_item", {
          select: ["id", "value"],
          orderBy: ["id", "asc"],
        }),
      ),
  }),
  extension: (ctx) => ctx.storage,
}))();

const unscopedPlugin = definePlugin(() => ({
  id: "unscoped" as const,
  schema: {
    raw_table: table("raw_table", {
      row_id: idColumn("row_id", "varchar(255)").defaultTo$("auto"),
      id: column("id", "varchar(255)"),
    }),
  },
  storage: () => ({}),
}))();

describe("executor FumaDB scope policy", () => {
  it("rejects plugin tables without an explicit executor scope policy", () => {
    expect(() => makeTestConfig({ plugins: [unscopedPlugin] as const })).toThrow(StorageError);
  });

  it.effect("allows in-scope partial reads and keeps hidden scope columns invisible", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: [innerScope],
          plugins: [leakyPlugin] as const,
        }),
      );

      yield* executor.leaky.create({
        id: "visible",
        scope_id: "inner",
        value: "ok",
      });

      const rows = yield* executor.leaky.readAll();
      expect(rows).toEqual([{ id: "visible", value: "ok" }]);
      expect("scope_id" in rows[0]!).toBe(false);
    }),
  );

  it.effect("scopes a buggy plugin read that forgets the scope predicate", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        scopes: [outerScope],
        plugins: [leakyPlugin] as const,
      });
      const outerExecutor = yield* createExecutor(config);
      yield* outerExecutor.leaky.create({
        id: "outer-only",
        scope_id: "outer",
        value: "secret",
      });

      const innerExecutor = yield* createExecutor({ ...config, scopes: [innerScope] });
      const rows = yield* innerExecutor.leaky.readAll();

      expect(rows).toEqual([]);
    }),
  );

  it.effect("blocks out-of-scope writes before they reach the database", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: [innerScope],
          plugins: [leakyPlugin] as const,
        }),
      );

      const error = yield* executor.leaky
        .create({
          id: "bad-write",
          scope_id: "outer",
          value: "nope",
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(StorageError);
      expect(error).toMatchObject({
        message: expect.stringContaining("outside the executor scope stack"),
      });
    }),
  );

  it.effect("scopes broad updates instead of touching rows outside the scope stack", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        scopes: [outerScope],
        plugins: [leakyPlugin] as const,
      });
      const outerExecutor = yield* createExecutor(config);
      yield* outerExecutor.leaky.create({
        id: "outer-row",
        scope_id: "outer",
        value: "secret",
      });

      const innerExecutor = yield* createExecutor({ ...config, scopes: [innerScope] });
      yield* innerExecutor.leaky.moveAll("inner");

      expect(yield* innerExecutor.leaky.readAll()).toEqual([]);
      expect(yield* outerExecutor.leaky.readAll()).toEqual([{ id: "outer-row", value: "secret" }]);
    }),
  );

  it.effect("blocks update values that write rows out of the scope stack", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: [innerScope],
          plugins: [leakyPlugin] as const,
        }),
      );
      yield* executor.leaky.create({
        id: "inner-row",
        scope_id: "inner",
        value: "ok",
      });

      const error = yield* executor.leaky.moveAll("outer").pipe(Effect.flip);
      expect(error).toBeInstanceOf(StorageError);
      expect(error).toMatchObject({
        message: expect.stringContaining("outside the executor scope stack"),
      });
    }),
  );

  it.effect("scopes broad deletes instead of touching rows outside the scope stack", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        scopes: [outerScope],
        plugins: [leakyPlugin] as const,
      });
      const outerExecutor = yield* createExecutor(config);
      yield* outerExecutor.leaky.create({
        id: "outer-row",
        scope_id: "outer",
        value: "secret",
      });

      const innerExecutor = yield* createExecutor({ ...config, scopes: [innerScope] });
      yield* innerExecutor.leaky.deleteAll();

      expect(yield* innerExecutor.leaky.readAll()).toEqual([]);
      expect(yield* outerExecutor.leaky.readAll()).toEqual([{ id: "outer-row", value: "secret" }]);
    }),
  );

  it.effect("scopes broad counts instead of counting rows outside the scope stack", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        scopes: [outerScope],
        plugins: [leakyPlugin] as const,
      });
      const outerExecutor = yield* createExecutor(config);
      yield* outerExecutor.leaky.create({
        id: "outer-row",
        scope_id: "outer",
        value: "secret",
      });

      const innerExecutor = yield* createExecutor({ ...config, scopes: [innerScope] });
      const count = yield* innerExecutor.leaky.countAll();

      expect(count).toBe(0);
    }),
  );
});
