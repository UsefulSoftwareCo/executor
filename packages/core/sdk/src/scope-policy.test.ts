import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { column, idColumn, table } from "fumadb/schema";

import { collectTables, createExecutor } from "./executor";
import { StorageError } from "./fuma-runtime";
import { ScopeId } from "./ids";
import { Scope } from "./scope";
import { dateColumn, scopedExecutorTable, textColumn } from "./core-schema";
import {
  assertExecutorScopeAllowed,
  executorScopePolicyName,
  type ExecutorScopePolicyContext,
} from "./scope-policy";
import { createSqliteTestFumaDb } from "./sqlite-test-db";

const scope = (id: string) =>
  Scope.make({
    id: ScopeId.make(id),
    name: id,
    createdAt: new Date(),
  });

const innerScope = scope("inner");

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

const unscopedSchema = {
  raw_table: table("raw_table", {
    row_id: idColumn("row_id", "varchar(255)").defaultTo$("auto"),
    id: column("id", "varchar(255)"),
  }),
};

const incompletePolicySchema = {
  incomplete_policy_table: table("incomplete_policy_table", {
    row_id: idColumn("row_id", "varchar(255)").defaultTo$("auto"),
    id: column("id", "varchar(255)"),
    scope_id: column("scope_id", "varchar(255)"),
  }).policy<ExecutorScopePolicyContext>({
    name: executorScopePolicyName,
  }),
};

describe("executor FumaDB scope policy", () => {
  it.effect("rejects direct database handles with unscoped table maps", () =>
    Effect.gen(function* () {
      const sqlite = yield* Effect.acquireRelease(
        Effect.promise(() =>
          createSqliteTestFumaDb({
            tables: {
              ...collectTables(),
              ...unscopedSchema,
            },
            namespace: "executor_unscoped_test",
          }),
        ),
        (db) => Effect.promise(() => db.close()).pipe(Effect.ignore),
      );

      const error = yield* createExecutor({
        scopes: [innerScope],
        db: sqlite.db,
        onElicitation: "accept-all",
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(StorageError);
      expect(error).toMatchObject({
        message: expect.stringContaining("missing an executor scope policy"),
      });
    }),
  );

  it.effect("rejects direct database handles that only copy the executor policy name", () =>
    Effect.gen(function* () {
      const sqlite = yield* Effect.acquireRelease(
        Effect.promise(() =>
          createSqliteTestFumaDb({
            tables: {
              ...collectTables(),
              ...incompletePolicySchema,
            },
            namespace: "executor_incomplete_policy_test",
          }),
        ),
        (db) => Effect.promise(() => db.close()).pipe(Effect.ignore),
      );

      const error = yield* createExecutor({
        scopes: [innerScope],
        db: sqlite.db,
        onElicitation: "accept-all",
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(StorageError);
      expect(error).toMatchObject({
        message: expect.stringContaining("missing an executor scope policy"),
      });
    }),
  );
});
