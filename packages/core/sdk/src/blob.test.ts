import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { StorageError } from "./fuma-runtime";

import { makeInMemoryBlobStore, pluginBlobStore, type OwnerPartitions } from "./blob";

// v2: owner partitions instead of a scope stack. Reads fall through
// [user, org] (user = innermost); writes/deletes name an explicit owner.
const partitions = (org: string, user: string | null): OwnerPartitions => ({
  org,
  user,
});

describe("pluginBlobStore", () => {
  it.effect("get returns user (innermost) value when both owners have one", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      yield* store.put("u/my-plugin", "k", "user-value");
      yield* store.put("o/my-plugin", "k", "org-value");

      const plugin = pluginBlobStore(store, partitions("o", "u"), "my-plugin");
      const value = yield* plugin.get("k");
      expect(value).toBe("user-value");
    }),
  );

  it.effect("get falls through to org when user partition is empty", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      yield* store.put("o/my-plugin", "k", "org-value");

      const plugin = pluginBlobStore(store, partitions("o", "u"), "my-plugin");
      const value = yield* plugin.get("k");
      expect(value).toBe("org-value");
    }),
  );

  it.effect("get returns null when no owner has the key", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      const plugin = pluginBlobStore(store, partitions("o", "u"), "my-plugin");
      const value = yield* plugin.get("k");
      expect(value).toBeNull();
    }),
  );

  it.effect("has returns true when any owner has the key", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      yield* store.put("o/my-plugin", "k", "v");

      const plugin = pluginBlobStore(store, partitions("o", "u"), "my-plugin");
      const found = yield* plugin.has("k");
      expect(found).toBe(true);
    }),
  );

  it.effect("has returns false when no owner has the key", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      const plugin = pluginBlobStore(store, partitions("o", "u"), "my-plugin");
      const found = yield* plugin.has("k");
      expect(found).toBe(false);
    }),
  );

  it.effect("namespaces are keyed by partition/pluginId — different plugins don't collide", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      yield* store.put("u/plugin-a", "k", "a-value");
      yield* store.put("u/plugin-b", "k", "b-value");

      const pluginA = pluginBlobStore(store, partitions("o", "u"), "plugin-a");
      const pluginB = pluginBlobStore(store, partitions("o", "u"), "plugin-b");
      expect(yield* pluginA.get("k")).toBe("a-value");
      expect(yield* pluginB.get("k")).toBe("b-value");
    }),
  );

  it.effect("put rejects owner:user when the executor has no subject", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      // No user partition → owner:"user" writes fail.
      const plugin = pluginBlobStore(store, partitions("o", null), "my-plugin");
      const err = yield* plugin.put("k", "v", { owner: "user" }).pipe(Effect.flip);
      expect(err).toBeInstanceOf(StorageError);
      // Write must not have reached the store.
      expect(yield* store.get("o/my-plugin", "k")).toBeNull();
    }),
  );

  it.effect("delete rejects owner:user when the executor has no subject", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      const plugin = pluginBlobStore(store, partitions("o", null), "my-plugin");
      const err = yield* plugin.delete("k", { owner: "user" }).pipe(Effect.flip);
      expect(err).toBeInstanceOf(StorageError);
    }),
  );
});

describe("BlobStore.getMany", () => {
  it.effect("returns hits keyed by namespace", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      yield* store.put("ns-a", "k", "a");
      yield* store.put("ns-c", "k", "c");

      const hits = yield* store.getMany(["ns-a", "ns-b", "ns-c"], "k");
      expect(hits.size).toBe(2);
      expect(hits.get("ns-a")).toBe("a");
      expect(hits.get("ns-b")).toBeUndefined();
      expect(hits.get("ns-c")).toBe("c");
    }),
  );

  it.effect("empty namespaces returns empty map", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      const hits = yield* store.getMany([], "k");
      expect(hits.size).toBe(0);
    }),
  );
});
