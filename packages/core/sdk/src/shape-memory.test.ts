import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as TestClock from "effect/testing/TestClock";

import type { Owner } from "./ids";
import type { PluginStorageEntry, PluginStorageFacade } from "./plugin-storage";
import { makeShapeMemory } from "./shape-memory";

const OWNER: Owner = "org";
const ADDRESS = "tools.demo.org.main.run";

/** Map-backed stand-in for plugin_storage, with a write counter. */
const makeStubStorage = () => {
  const rows = new Map<string, unknown>();
  let writes = 0;
  const entryFor = <T>(key: string): PluginStorageEntry<T> | null => {
    const data = rows.get(key);
    if (data === undefined) return null;
    return {
      id: key,
      owner: OWNER,
      pluginId: "executor.shape-memory",
      collection: "observed-output-shapes",
      key,
      data: data as T,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  };
  let failNextWrites = 0;
  const unsupported = (member: string) => () =>
    Effect.die(`stub storage does not implement ${member}`);
  const storage: PluginStorageFacade = {
    collection: () => ({
      get: unsupported("collection.get"),
      getForOwner: unsupported("collection.getForOwner"),
      list: unsupported("collection.list"),
      put: unsupported("collection.put"),
      query: unsupported("collection.query"),
      count: unsupported("collection.count"),
      remove: unsupported("collection.remove"),
    }),
    get: (input) => Effect.sync(() => entryFor(input.key)),
    getForOwner: (input) => Effect.sync(() => entryFor(input.key)),
    list: unsupported("list"),
    put: (input) =>
      Effect.suspend(() => {
        if (failNextWrites > 0) {
          failNextWrites -= 1;
          return Effect.fail({ _tag: "StorageError" as const }) as never;
        }
        writes += 1;
        rows.set(input.key, input.data);
        return Effect.sync(() => entryFor(input.key) as never);
      }),
    putMany: unsupported("putMany"),
    remove: unsupported("remove"),
    removeMany: unsupported("removeMany"),
  };
  return {
    storage,
    rows,
    writeCount: () => writes,
    failWrites: (count: number) => {
      failNextWrites = count;
    },
  };
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("makeShapeMemory", () => {
  it.effect("recalls what it observed, and writes only on change or freshness", () =>
    Effect.gen(function* () {
      const stub = makeStubStorage();
      const memory = makeShapeMemory(stub.storage);

      yield* memory.observe(ADDRESS, OWNER, "direct", { id: 1 });
      expect(stub.writeCount(), "first observation persists").toBe(1);

      // Identical shape shortly after: no write.
      yield* TestClock.adjust("1 minute");
      yield* memory.observe(ADDRESS, OWNER, "direct", { id: 2 });
      expect(stub.writeCount(), "stable shape does not write").toBe(1);

      // Shape change: writes.
      yield* memory.observe(ADDRESS, OWNER, "direct", { id: 3, extra: true });
      expect(stub.writeCount(), "changed shape writes").toBe(2);

      const recalled = yield* memory.recall(ADDRESS, OWNER, "direct");
      expect(recalled?.observations).toBe(3);
      expect(recalled?.schema.required).toEqual(["id"]);
    }),
  );

  it.effect("persists freshness on the interval even when the shape is stable", () =>
    Effect.gen(function* () {
      const stub = makeStubStorage();
      const memory = makeShapeMemory(stub.storage);

      yield* memory.observe(ADDRESS, OWNER, "direct", { id: 1 });
      yield* memory.observe(ADDRESS, OWNER, "direct", { id: 2 });
      expect(stub.writeCount()).toBe(1);

      yield* TestClock.adjust("7 hours");
      yield* memory.observe(ADDRESS, OWNER, "direct", { id: 3 });
      expect(stub.writeCount(), "staleness alone forces a freshness write").toBe(2);
      const stored = stub.rows.get(ADDRESS) as { observations: number; updatedAt: number };
      expect(stored.observations, "persisted counters are current").toBe(3);
      expect(stored.updatedAt).toBe(7 * HOUR + 0);
    }),
  );

  it.effect("ignores a record observed under a different contract and restarts on observe", () =>
    Effect.gen(function* () {
      const stub = makeStubStorage();
      const memory = makeShapeMemory(stub.storage);

      yield* memory.observe(ADDRESS, OWNER, "direct", { content: [{ type: "text" }] });
      expect(yield* memory.recall(ADDRESS, OWNER, "direct")).not.toBeNull();
      expect(
        yield* memory.recall(ADDRESS, OWNER, "mcp-call-tool-result-v2"),
        "other contract sees nothing",
      ).toBeNull();

      // Observing under the new contract replaces rather than merges.
      yield* memory.observe(ADDRESS, OWNER, "mcp-call-tool-result-v2", { issues: [] });
      const fresh = yield* memory.recall(ADDRESS, OWNER, "mcp-call-tool-result-v2");
      expect(fresh?.observations).toBe(1);
      expect(Object.keys(fresh?.schema.properties ?? {})).toEqual(["issues"]);
    }),
  );

  it.effect("retries after a failed write instead of pretending it persisted", () =>
    Effect.gen(function* () {
      const stub = makeStubStorage();
      const memory = makeShapeMemory(stub.storage);

      stub.failWrites(1);
      yield* memory.observe(ADDRESS, OWNER, "direct", { id: 1 });
      expect(stub.rows.has(ADDRESS), "the failed write stored nothing").toBe(false);

      // The very next observation retries — no waiting out the freshness
      // interval on bookkeeping that lied about persisting.
      yield* memory.observe(ADDRESS, OWNER, "direct", { id: 2 });
      expect(stub.rows.has(ADDRESS), "the retry persisted").toBe(true);
      const stored = stub.rows.get(ADDRESS) as { observations: number };
      expect(stored.observations).toBe(2);
    }),
  );

  it.effect("treats legacy records without a contract field as direct", () =>
    Effect.gen(function* () {
      const stub = makeStubStorage();
      stub.rows.set(ADDRESS, {
        schema: { type: "object", properties: { ran: { type: "string" } }, required: ["ran"] },
        observations: 4,
        updatedAt: 0,
      });
      const memory = makeShapeMemory(stub.storage);
      const recalled = yield* memory.recall(ADDRESS, OWNER, "direct");
      expect(recalled?.observations).toBe(4);
    }),
  );

  it.effect("expires shapes that have not been reinforced", () =>
    Effect.gen(function* () {
      const stub = makeStubStorage();
      const memory = makeShapeMemory(stub.storage);

      yield* memory.observe(ADDRESS, OWNER, "direct", { id: 1 });
      yield* TestClock.adjust("29 days");
      expect(yield* memory.recall(ADDRESS, OWNER, "direct"), "fresh enough").not.toBeNull();

      yield* TestClock.adjust("2 days");
      expect(yield* memory.recall(ADDRESS, OWNER, "direct"), "expired").toBeNull();

      // The next observation restarts instead of merging into the fossil.
      yield* memory.observe(ADDRESS, OWNER, "direct", { fresh: true });
      const restarted = yield* memory.recall(ADDRESS, OWNER, "direct");
      expect(restarted?.observations).toBe(1);
      expect(Object.keys(restarted?.schema.properties ?? {})).toEqual(["fresh"]);
      void DAY;
    }),
  );
});
