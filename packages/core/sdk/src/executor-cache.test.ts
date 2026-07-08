// ---------------------------------------------------------------------------
// `executor.cache` — the SDK cache seam. A host-provided KeyValueStore wins;
// absent one the executor falls back to a bounded in-memory store with TTL
// expiry and LRU eviction. The fallback is Clock-based, so TTL is pinned with
// the virtual TestClock instead of patching Date.now.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";

import { createExecutor } from "./executor";
import { makeTestConfig } from "./test-config";

const makeExecutor = (cache?: KeyValueStore.KeyValueStore) =>
  createExecutor(makeTestConfig(cache !== undefined ? { cache } : {}));

describe("executor cache", () => {
  it.effect("falls back to an in-memory store when no cache is configured", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* makeExecutor();

        yield* executor.cache.set("a", "value");
        expect(yield* executor.cache.get("a")).toBe("value");

        yield* executor.cache.remove("a");
        expect(yield* executor.cache.get("a")).toBeUndefined();
      }),
    ),
  );

  it.effect("prefers a host-provided store", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backing = new Map<string, string>();
        const hostStore = KeyValueStore.makeStringOnly({
          get: (key) => Effect.sync(() => backing.get(key)),
          set: (key, value) => Effect.sync(() => void backing.set(key, value)),
          remove: (key) => Effect.sync(() => void backing.delete(key)),
          clear: Effect.sync(() => backing.clear()),
          size: Effect.sync(() => backing.size),
        });
        const executor = yield* makeExecutor(hostStore);

        yield* executor.cache.set("a", "value");
        expect(backing.get("a")).toBe("value");
      }),
    ),
  );

  it.effect("expires fallback entries by TTL", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* makeExecutor();

        yield* executor.cache.set("a", "value");
        expect(yield* executor.cache.size).toBe(1);

        yield* TestClock.adjust("10 minutes");

        expect(yield* executor.cache.get("a")).toBeUndefined();
        expect(yield* executor.cache.size).toBe(0);
      }),
    ),
  );

  it.effect("evicts the least recently used key at capacity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* makeExecutor();
        const capacity = 2_048;

        yield* executor.cache.set("a", "old");
        for (let index = 0; index < capacity - 1; index += 1) {
          yield* executor.cache.set(`key-${index}`, String(index));
        }

        // Re-writing "a" refreshes its LRU position, so the overflow evicts
        // the oldest untouched key instead.
        yield* executor.cache.set("a", "new");
        yield* executor.cache.set("overflow", "value");

        expect(yield* executor.cache.get("a")).toBe("new");
        expect(yield* executor.cache.get("key-0")).toBeUndefined();
        expect(yield* executor.cache.get("key-1")).toBe("1");
      }),
    ),
  );
});
