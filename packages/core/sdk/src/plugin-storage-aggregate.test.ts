import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import type { StorageFailure } from "./fuma-runtime";
import { Owner } from "./ids";
import { definePlugin } from "./plugin";
import {
  definePluginStorageCollection,
  type PluginStorageAggregateFilter,
  type PluginStorageGroupCountInput,
  type PluginStorageQueryKeysetInput,
  type PluginStorageStatsInput,
  type PluginStorageTimeBucketInput,
} from "./plugin-storage";
import { makeTestExecutor } from "./testing";

const Run = Schema.Struct({
  status: Schema.Literals(["completed", "failed", "running"]),
  triggerKind: Schema.NullOr(Schema.String),
  startedAt: Schema.Number,
  durationMs: Schema.NullOr(Schema.Number),
  hadInteraction: Schema.Boolean,
});
type Run = typeof Run.Type;

const runs = definePluginStorageCollection("runs", Run, {
  indexes: ["status", "triggerKind", "startedAt", "durationMs", "hadInteraction"],
});

const runsPlugin = definePlugin(() => ({
  id: "runs" as const,
  pluginStorage: { runs },
  storage: ({ pluginStorage }) => ({ runs: pluginStorage.collection(runs) }),
  extension: (ctx) => ({
    record: (owner: Owner, key: string, data: Run) => ctx.storage.runs.put({ owner, key, data }),
    count: (input?: PluginStorageAggregateFilter<typeof runs>) =>
      ctx.storage.runs.aggregate.count(input),
    groupCount: (input: PluginStorageGroupCountInput<typeof runs>) =>
      ctx.storage.runs.aggregate.groupCount(input),
    timeBuckets: (input: PluginStorageTimeBucketInput<typeof runs>) =>
      ctx.storage.runs.aggregate.timeBuckets(input),
    stats: (input: PluginStorageStatsInput<typeof runs>) => ctx.storage.runs.aggregate.stats(input),
    keyset: (input: PluginStorageQueryKeysetInput<typeof runs>) =>
      ctx.storage.runs.queryKeyset(input),
  }),
}))();

const seedRows: readonly (readonly [string, Run])[] = [
  [
    "r1",
    {
      status: "completed",
      triggerKind: "cli",
      startedAt: 1000,
      durationMs: 100,
      hadInteraction: false,
    },
  ],
  [
    "r2",
    {
      status: "completed",
      triggerKind: "cli",
      startedAt: 2000,
      durationMs: 200,
      hadInteraction: false,
    },
  ],
  [
    "r3",
    {
      status: "failed",
      triggerKind: "http",
      startedAt: 3000,
      durationMs: 300,
      hadInteraction: true,
    },
  ],
  [
    "r4",
    {
      status: "running",
      triggerKind: "http",
      startedAt: 4000,
      durationMs: null,
      hadInteraction: false,
    },
  ],
];

const seed = (executor: {
  runs: {
    record: (owner: Owner, key: string, data: Run) => Effect.Effect<unknown, StorageFailure>;
  };
}) =>
  Effect.forEach(seedRows, ([key, data]) => executor.runs.record("org", key, data), {
    discard: true,
  });

describe("plugin storage aggregate + keyset (SQLite pushdown)", () => {
  it.effect("counts with JSON filters and numeric ranges", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ plugins: [runsPlugin] as const });
      yield* seed(executor);

      expect(yield* executor.runs.count()).toBe(4);
      expect(yield* executor.runs.count({ where: { status: "completed" } })).toBe(2);
      expect(yield* executor.runs.count({ where: { startedAt: { gte: 3000 } } })).toBe(2);
      expect(yield* executor.runs.count({ where: { durationMs: { gte: 200 } } })).toBe(2);
      expect(yield* executor.runs.count({ where: { hadInteraction: true } })).toBe(1);
    }),
  );

  it.effect("groups counts by a JSON field (facets)", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ plugins: [runsPlugin] as const });
      yield* seed(executor);

      const byStatus = yield* executor.runs.groupCount({ field: "status" });
      expect(Object.fromEntries(byStatus.map((row) => [row.value, row.count]))).toEqual({
        completed: 2,
        failed: 1,
        running: 1,
      });

      const byTrigger = yield* executor.runs.groupCount({ field: "triggerKind" });
      expect(Object.fromEntries(byTrigger.map((row) => [row.value, row.count]))).toEqual({
        cli: 2,
        http: 2,
      });
    }),
  );

  it.effect("buckets a numeric field over time", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ plugins: [runsPlugin] as const });
      yield* seed(executor);

      const buckets = yield* executor.runs.timeBuckets({ field: "startedAt", bucketMs: 2000 });
      expect(buckets).toEqual([
        { bucket: 0, count: 1 },
        { bucket: 2000, count: 2 },
        { bucket: 4000, count: 1 },
      ]);
    }),
  );

  it.effect("computes duration stats and percentiles", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ plugins: [runsPlugin] as const });
      yield* seed(executor);

      const stats = yield* executor.runs.stats({ field: "durationMs", percentiles: [0, 0.5, 1] });
      expect(stats.count).toBe(3);
      expect(stats.min).toBe(100);
      expect(stats.max).toBe(300);
      expect(stats.percentiles).toEqual([
        { fraction: 0, value: 100 },
        { fraction: 0.5, value: 200 },
        { fraction: 1, value: 300 },
      ]);
    }),
  );

  it.effect("keyset-paginates with a cursor and JSON filter", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ plugins: [runsPlugin] as const });
      yield* seed(executor);

      const page1 = yield* executor.runs.keyset({
        orderBy: [{ field: "startedAt", direction: "desc", valueType: "number" }],
        limit: 2,
      });
      expect(page1.entries.map((entry) => entry.key)).toEqual(["r4", "r3"]);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = yield* executor.runs.keyset({
        orderBy: [{ field: "startedAt", direction: "desc", valueType: "number" }],
        limit: 2,
        cursor: page1.nextCursor ?? undefined,
      });
      expect(page2.entries.map((entry) => entry.key)).toEqual(["r2", "r1"]);

      const page3 = yield* executor.runs.keyset({
        orderBy: [{ field: "startedAt", direction: "desc", valueType: "number" }],
        limit: 2,
        cursor: page2.nextCursor ?? undefined,
      });
      expect(page3.entries).toHaveLength(0);
      expect(page3.nextCursor).toBeNull();

      const completed = yield* executor.runs.keyset({
        where: { status: "completed" },
        orderBy: [{ field: "startedAt", direction: "asc", valueType: "number" }],
        limit: 10,
      });
      expect(completed.entries.map((entry) => entry.key)).toEqual(["r1", "r2"]);
    }),
  );
});
