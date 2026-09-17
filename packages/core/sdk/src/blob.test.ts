import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { StorageError } from "./fuma-runtime";

import {
  makeInMemoryBlobStore,
  pluginBlobStore,
  type BlobAccess,
  type OwnerPartitions,
} from "./blob";

// v2: owner partitions instead of a scope stack. Reads fall through the
// product view's owners in their supplied order (first listed wins); writes
// and deletes name an explicit owner and are refused outside the view.
const partitions = (org: string, user: string | null): OwnerPartitions => ({
  org,
  user,
});

// The full member view — the pre-BlobAccess behavior: user shadows org on
// read, both partitions writable.
const fullView: BlobAccess = { owners: ["user", "org"], storageWrites: "allowed" };
const personalOnly: BlobAccess = { owners: ["user"], storageWrites: "allowed" };
const orgOnly: BlobAccess = { owners: ["org"], storageWrites: "allowed" };

describe("pluginBlobStore", () => {
  it.effect("get returns user (first-ranked) value when both owners have one", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      yield* store.put("u/my-plugin", "k", "user-value");
      yield* store.put("o/my-plugin", "k", "org-value");

      const plugin = pluginBlobStore(store, partitions("o", "u"), "my-plugin", fullView);
      const value = yield* plugin.get("k");
      expect(value).toBe("user-value");
    }),
  );

  it.effect("get falls through to org when user partition is empty", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      yield* store.put("o/my-plugin", "k", "org-value");

      const plugin = pluginBlobStore(store, partitions("o", "u"), "my-plugin", fullView);
      const value = yield* plugin.get("k");
      expect(value).toBe("org-value");
    }),
  );

  it.effect("get returns null when no owner has the key", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      const plugin = pluginBlobStore(store, partitions("o", "u"), "my-plugin", fullView);
      const value = yield* plugin.get("k");
      expect(value).toBeNull();
    }),
  );

  it.effect("has returns true when any owner has the key", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      yield* store.put("o/my-plugin", "k", "v");

      const plugin = pluginBlobStore(store, partitions("o", "u"), "my-plugin", fullView);
      const found = yield* plugin.has("k");
      expect(found).toBe(true);
    }),
  );

  it.effect("has returns false when no owner has the key", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      const plugin = pluginBlobStore(store, partitions("o", "u"), "my-plugin", fullView);
      const found = yield* plugin.has("k");
      expect(found).toBe(false);
    }),
  );

  it.effect("namespaces are keyed by partition/pluginId — different plugins don't collide", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      yield* store.put("u/plugin-a", "k", "a-value");
      yield* store.put("u/plugin-b", "k", "b-value");

      const pluginA = pluginBlobStore(store, partitions("o", "u"), "plugin-a", fullView);
      const pluginB = pluginBlobStore(store, partitions("o", "u"), "plugin-b", fullView);
      expect(yield* pluginA.get("k")).toBe("a-value");
      expect(yield* pluginB.get("k")).toBe("b-value");
    }),
  );

  it.effect("put rejects owner:user when the executor has no subject", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      // No user partition → owner:"user" writes fail even when the product
      // view lists "user"; the identity clamp is not the product's to relax.
      const plugin = pluginBlobStore(store, partitions("o", null), "my-plugin", fullView);
      const err = yield* plugin.put("k", "v", { owner: "user" }).pipe(Effect.flip);
      expect(err).toBeInstanceOf(StorageError);
      expect(err).toMatchObject({
        message: 'Blob write targets owner "user" but the executor has no subject.',
      });
      // Write must not have reached the store.
      expect(yield* store.get("o/my-plugin", "k")).toBeNull();
    }),
  );

  it.effect("delete rejects owner:user when the executor has no subject", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      const plugin = pluginBlobStore(store, partitions("o", null), "my-plugin", fullView);
      const err = yield* plugin.delete("k", { owner: "user" }).pipe(Effect.flip);
      expect(err).toBeInstanceOf(StorageError);
      expect(err).toMatchObject({
        message: 'Blob write targets owner "user" but the executor has no subject.',
      });
    }),
  );
});

describe("pluginBlobStore access clamp", () => {
  it.effect("personal-only view cannot read an org blob", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      // e.g. an org-shared provider config holding a service-account token.
      yield* store.put("o/my-plugin", "k", "org-secret");

      const plugin = pluginBlobStore(store, partitions("o", "u"), "my-plugin", personalOnly);
      expect(yield* plugin.get("k")).toBeNull();
      expect(yield* plugin.has("k")).toBe(false);
    }),
  );

  it.effect("personal-only view still reads its own user blob", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      yield* store.put("u/my-plugin", "k", "user-value");
      yield* store.put("o/my-plugin", "k", "org-value");

      const plugin = pluginBlobStore(store, partitions("o", "u"), "my-plugin", personalOnly);
      expect(yield* plugin.get("k")).toBe("user-value");
    }),
  );

  it.effect("org-only view with a bound subject cannot read a user blob", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      yield* store.put("u/my-plugin", "k", "user-value");

      const plugin = pluginBlobStore(store, partitions("o", "u"), "my-plugin", orgOnly);
      expect(yield* plugin.get("k")).toBeNull();
      expect(yield* plugin.has("k")).toBe(false);
    }),
  );

  it.effect("read precedence follows the supplied owner order", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      yield* store.put("u/my-plugin", "k", "user-value");
      yield* store.put("o/my-plugin", "k", "org-value");

      const orgFirst = pluginBlobStore(store, partitions("o", "u"), "my-plugin", {
        owners: ["org", "user"],
        storageWrites: "allowed",
      });
      expect(yield* orgFirst.get("k")).toBe("org-value");
    }),
  );

  it.effect("put outside the view is rejected and does not reach the store", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      const plugin = pluginBlobStore(store, partitions("o", "u"), "my-plugin", personalOnly);
      const err = yield* plugin.put("k", "v", { owner: "org" }).pipe(Effect.flip);
      expect(err).toBeInstanceOf(StorageError);
      expect(err).toMatchObject({
        message:
          'Blob write targets the "org" partition, which this product view does not include.',
      });
      expect(yield* store.get("o/my-plugin", "k")).toBeNull();
    }),
  );

  it.effect("delete outside the view is rejected and leaves the row in place", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      yield* store.put("o/my-plugin", "k", "org-value");

      const plugin = pluginBlobStore(store, partitions("o", "u"), "my-plugin", personalOnly);
      const err = yield* plugin.delete("k", { owner: "org" }).pipe(Effect.flip);
      expect(err).toBeInstanceOf(StorageError);
      expect(err).toMatchObject({
        message:
          'Blob write targets the "org" partition, which this product view does not include.',
      });
      expect(yield* store.get("o/my-plugin", "k")).toBe("org-value");
    }),
  );

  it.effect("org-only view cannot write the user partition", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      const plugin = pluginBlobStore(store, partitions("o", "u"), "my-plugin", orgOnly);
      const err = yield* plugin.put("k", "v", { owner: "user" }).pipe(Effect.flip);
      expect(err).toBeInstanceOf(StorageError);
      expect(err).toMatchObject({
        message:
          'Blob write targets the "user" partition, which this product view does not include.',
      });
      expect(yield* store.get("u/my-plugin", "k")).toBeNull();
    }),
  );

  it.effect("read-only view refuses every mutation but keeps reading", () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      yield* store.put("o/my-plugin", "k", "org-value");

      const plugin = pluginBlobStore(store, partitions("o", "u"), "my-plugin", {
        owners: ["user", "org"],
        storageWrites: "denied",
      });
      const putErr = yield* plugin.put("k", "v", { owner: "org" }).pipe(Effect.flip);
      expect(putErr).toBeInstanceOf(StorageError);
      expect(putErr.message).toBe(
        'Blob write on plugin "my-plugin" is not allowed: this executor\'s storage is read-only.',
      );
      const userPutErr = yield* plugin.put("k", "v", { owner: "user" }).pipe(Effect.flip);
      expect(userPutErr).toBeInstanceOf(StorageError);
      const deleteErr = yield* plugin.delete("k", { owner: "org" }).pipe(Effect.flip);
      expect(deleteErr).toBeInstanceOf(StorageError);
      // Nothing was mutated; reads keep working.
      expect(yield* store.get("o/my-plugin", "k")).toBe("org-value");
      expect(yield* plugin.get("k")).toBe("org-value");
    }),
  );

  it.effect('a view listing "user" on a subject-less identity reads org rows only', () =>
    Effect.gen(function* () {
      const store = makeInMemoryBlobStore();
      yield* store.put("o/my-plugin", "k", "org-value");

      // `createExecutor` validation rejects this shape, but the seam must not
      // assume it: the null partition contributes no namespace, not a failure.
      const plugin = pluginBlobStore(store, partitions("o", null), "my-plugin", fullView);
      expect(yield* plugin.get("k")).toBe("org-value");
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
