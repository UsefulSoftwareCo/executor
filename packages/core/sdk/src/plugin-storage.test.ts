import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Schema } from "effect";

import { StorageError } from "./fuma-runtime";
import { Owner } from "./ids";
import { definePlugin } from "./plugin";
import {
  definePluginStorageCollection,
  type PluginStorageCollectionFacade,
  type PluginStorageCollectionQueryInput,
  type PluginStorageCollectionWhere,
} from "./plugin-storage";
import { makeTestExecutor } from "./testing";

const ToolCall = Schema.Struct({
  runId: Schema.String,
  toolId: Schema.String,
  userId: Schema.NullOr(Schema.String),
  clientName: Schema.NullOr(Schema.String),
  status: Schema.Literals(["ok", "failed", "blocked"]),
  startedAt: Schema.String,
  durationMs: Schema.Number,
});

const toolCalls = definePluginStorageCollection("toolCalls", ToolCall, {
  indexes: ["runId", "toolId", "status", "clientName", "startedAt", ["toolId", "startedAt"]],
});

type ToolCall = typeof ToolCall.Type;

const assertPluginStorageTypes = (storage: PluginStorageCollectionFacade<typeof toolCalls>) => {
  const validQuery = storage.query({ where: { toolId: "shell" } });

  // @ts-expect-error durationMs is part of the data shape but is not declared as an index.
  const invalidWhereQuery = storage.query({ where: { durationMs: 100 } });

  // prettier-ignore
  // @ts-expect-error orderBy is also restricted to declared index fields.
  const invalidOrderQuery = storage.query({ orderBy: [{ field: "durationMs" }] });

  // @ts-expect-error indexes must point at fields in the collection schema.
  definePluginStorageCollection("bad", ToolCall, { indexes: ["missing"] });

  void validQuery;
  void invalidWhereQuery;
  void invalidOrderQuery;
};
void assertPluginStorageTypes;

const uncheckedToolCallWhere = (
  where: Readonly<Record<string, unknown>>,
): PluginStorageCollectionWhere<typeof toolCalls> =>
  where as PluginStorageCollectionWhere<typeof toolCalls>;

const executionHistoryPlugin = definePlugin(() => ({
  id: "executionHistory" as const,
  pluginStorage: { toolCalls },
  storage: ({ pluginStorage }) => ({
    toolCalls: pluginStorage.collection(toolCalls),
  }),
  extension: (ctx) => ({
    record: (owner: Owner, key: string, data: ToolCall) =>
      ctx.storage.toolCalls.put({ owner, key, data }),
    recordMany: (
      owner: Owner,
      rows: readonly { readonly key: string; readonly data: ToolCall }[],
    ) =>
      ctx.pluginStorage.putMany({
        owner,
        entries: rows.map((row) => ({
          collection: toolCalls.name,
          key: row.key,
          data: row.data,
        })),
      }),
    removeMany: (owner: Owner, keys: readonly string[]) =>
      ctx.pluginStorage.removeMany({
        owner,
        entries: keys.map((key) => ({ collection: toolCalls.name, key })),
      }),
    get: (key: string) => ctx.storage.toolCalls.get({ key }),
    getForOwner: (owner: Owner, key: string) => ctx.storage.toolCalls.getForOwner({ owner, key }),
    query: (input?: PluginStorageCollectionQueryInput<typeof toolCalls>) =>
      ctx.storage.toolCalls.query(input),
    count: (
      input?: Omit<
        PluginStorageCollectionQueryInput<typeof toolCalls>,
        "orderBy" | "limit" | "offset"
      >,
    ) => ctx.storage.toolCalls.count(input),
    queryUnindexed: () =>
      ctx.storage.toolCalls.query({
        where: uncheckedToolCallWhere({ durationMs: 100 }),
      }),
  }),
}))();

const call = (input: {
  readonly runId: string;
  readonly toolId: string;
  readonly status: ToolCall["status"];
  readonly startedAt: string;
  readonly clientName?: string | null;
  readonly userId?: string | null;
  readonly durationMs?: number;
}): ToolCall => ({
  runId: input.runId,
  toolId: input.toolId,
  userId: input.userId ?? null,
  clientName: input.clientName ?? null,
  status: input.status,
  startedAt: input.startedAt,
  durationMs: input.durationMs ?? 0,
});

describe("plugin storage collections", () => {
  it.effect("queries declared indexes through the executor's SQLite FumaDB target", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        backend: "sqlite",
        plugins: [executionHistoryPlugin] as const,
      });

      yield* executor.executionHistory.record(
        "org",
        "call-1",
        call({
          runId: "run-a",
          toolId: "browser",
          status: "failed",
          clientName: "codex",
          startedAt: "2026-05-29T10:00:00.000Z",
          durationMs: 320,
        }),
      );
      yield* executor.executionHistory.record(
        "org",
        "call-2",
        call({
          runId: "run-a",
          toolId: "shell",
          status: "ok",
          clientName: "codex",
          startedAt: "2026-05-29T10:01:00.000Z",
          durationMs: 42,
        }),
      );
      yield* executor.executionHistory.record(
        "org",
        "call-3",
        call({
          runId: "run-b",
          toolId: "shell",
          status: "failed",
          clientName: "codex",
          startedAt: "2026-05-29T10:02:00.000Z",
          durationMs: 77,
        }),
      );

      const failed = yield* executor.executionHistory.query({
        where: {
          clientName: "codex",
          status: "failed",
        },
        orderBy: [{ field: "startedAt", direction: "desc" }],
        limit: 10,
      });
      expect(failed.map((entry) => entry.key)).toEqual(["call-3", "call-1"]);
      expect(failed.map((entry) => entry.data.toolId)).toEqual(["shell", "browser"]);

      const shellCount = yield* executor.executionHistory.count({
        where: { toolId: "shell" },
      });
      expect(shellCount).toBe(2);
    }),
  );

  it.effect("bulk puts and removes plugin storage rows", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        backend: "sqlite",
        plugins: [executionHistoryPlugin] as const,
      });
      const rows = Array.from({ length: 95 }, (_, index) => ({
        key: `call-${String(index).padStart(3, "0")}`,
        data: call({
          runId: "run-bulk",
          toolId: index % 2 === 0 ? "browser" : "shell",
          status: "ok",
          startedAt: new Date(Date.UTC(2026, 4, 29, 12, index)).toISOString(),
        }),
      }));

      yield* executor.executionHistory.recordMany("org", rows);
      yield* executor.executionHistory.recordMany("org", [
        {
          key: "call-000",
          data: call({
            runId: "run-bulk",
            toolId: "browser",
            status: "failed",
            startedAt: "2026-05-29T12:00:00.000Z",
          }),
        },
      ]);

      const stored = yield* executor.executionHistory.query({
        where: { runId: "run-bulk" },
        orderBy: [{ field: "startedAt" }],
      });
      expect(stored).toHaveLength(95);
      expect(stored[0]?.key).toBe("call-000");
      expect(stored[0]?.data.status).toBe("failed");

      yield* executor.executionHistory.removeMany(
        "org",
        rows.map((row) => row.key),
      );
      const remaining = yield* executor.executionHistory.query({ where: { runId: "run-bulk" } });
      expect(remaining).toEqual([]);
    }),
  );

  it.effect("bulk puts large plugin storage row sets in bounded batches", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        backend: "sqlite",
        plugins: [executionHistoryPlugin] as const,
      });
      const rows = Array.from({ length: 7_000 }, (_, index) => ({
        key: `large-call-${String(index).padStart(5, "0")}`,
        data: call({
          runId: "run-large-bulk",
          toolId: index % 2 === 0 ? "browser" : "shell",
          status: "ok",
          startedAt: new Date(Date.UTC(2026, 4, 29, 12, 0, index)).toISOString(),
        }),
      }));

      yield* executor.executionHistory.recordMany("org", rows);

      const count = yield* executor.executionHistory.count({
        where: { runId: "run-large-bulk" },
      });
      expect(count).toBe(rows.length);
    }),
  );

  it.effect("user rows shadow org rows on read; both share one plugin_storage table", () =>
    Effect.gen(function* () {
      // One executor bound to a subject sees both org and user owner rows; a
      // user-owned row shadows an org-owned row under the same key on read.
      const executor = yield* makeTestExecutor({
        backend: "sqlite",
        plugins: [executionHistoryPlugin] as const,
      });

      yield* executor.executionHistory.record(
        "org",
        "shared",
        call({
          runId: "run-scope",
          toolId: "shell",
          status: "ok",
          startedAt: "2026-05-29T11:00:00.000Z",
        }),
      );
      yield* executor.executionHistory.record(
        "user",
        "shared",
        call({
          runId: "run-scope",
          toolId: "browser",
          status: "failed",
          startedAt: "2026-05-29T11:01:00.000Z",
        }),
      );

      const visibleShared = yield* executor.executionHistory.get("shared");
      expect(visibleShared?.owner).toBe("user");
      expect(visibleShared?.data.toolId).toBe("browser");

      const scopedRows = yield* executor.executionHistory.query({
        where: { runId: "run-scope" },
        orderBy: [{ field: "startedAt" }],
      });
      expect(
        scopedRows.map((entry) => [entry.key, String(entry.owner), entry.data.toolId]),
      ).toEqual([
        ["shared", "org", "shell"],
        ["shared", "user", "browser"],
      ]);
    }),
  );

  it.effect("rejects runtime queries against undeclared index fields", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        backend: "sqlite",
        plugins: [executionHistoryPlugin] as const,
      });

      const exit = yield* Effect.exit(executor.executionHistory.queryUnindexed());
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;

      const reason = exit.cause.reasons.find(Cause.isFailReason);
      expect(reason?.error).toBeInstanceOf(StorageError);
      expect(reason?.error).toMatchObject({
        message:
          'Plugin storage collection "toolCalls" cannot query field "durationMs" because it is not declared as an index',
      });
    }),
  );
});
