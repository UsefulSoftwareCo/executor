import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { R2Bucket } from "@cloudflare/workers-types";

import { StorageError, pluginBlobStore } from "@executor-js/sdk";

import { makeR2BlobStore } from "./blob-store";

// Minimal in-memory R2 bucket double — covers the get/put/delete/head slice
// the store uses. Typed via the boundary cast because a full R2Bucket carries
// a dozen unrelated methods.
const makeFakeBucket = (): { bucket: R2Bucket; objects: Map<string, string> } => {
  const objects = new Map<string, string>();
  // oxlint-disable-next-line executor/no-double-cast -- test double: only the slice the store calls is implemented
  const bucket = {
    get: async (key: string) => {
      const value = objects.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    put: async (key: string, value: string) => {
      objects.set(key, value);
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
    head: async (key: string) => (objects.has(key) ? {} : null),
  } as unknown as R2Bucket;
  return { bucket, objects };
};

describe("makeR2BlobStore", () => {
  it.effect("round-trips a value and names objects `namespace/key`", () =>
    Effect.gen(function* () {
      const { bucket, objects } = makeFakeBucket();
      const store = makeR2BlobStore(bucket);

      yield* store.put("o:t1/openapi", "spec/abc123", "spec-text");
      expect(yield* store.get("o:t1/openapi", "spec/abc123")).toBe("spec-text");
      expect(objects.has("o:t1/openapi/spec/abc123")).toBe(true);
    }),
  );

  it.effect("get returns null for a missing object", () =>
    Effect.gen(function* () {
      const { bucket } = makeFakeBucket();
      const store = makeR2BlobStore(bucket);
      expect(yield* store.get("o:t1/openapi", "missing")).toBeNull();
    }),
  );

  it.effect("getMany returns hits keyed by namespace", () =>
    Effect.gen(function* () {
      const { bucket } = makeFakeBucket();
      const store = makeR2BlobStore(bucket);
      yield* store.put("u:t1:s1/openapi", "k", "user-value");
      yield* store.put("o:t1/openapi", "k", "org-value");

      const hits = yield* store.getMany(["u:t1:s1/openapi", "o:t1/openapi", "o:t2/openapi"], "k");
      expect(hits.size).toBe(2);
      expect(hits.get("u:t1:s1/openapi")).toBe("user-value");
      expect(hits.get("o:t1/openapi")).toBe("org-value");
    }),
  );

  it.effect("delete and has agree", () =>
    Effect.gen(function* () {
      const { bucket } = makeFakeBucket();
      const store = makeR2BlobStore(bucket);
      yield* store.put("ns/p", "k", "v");
      expect(yield* store.has("ns/p", "k")).toBe(true);
      yield* store.delete("ns/p", "k");
      expect(yield* store.has("ns/p", "k")).toBe(false);
      expect(yield* store.get("ns/p", "k")).toBeNull();
    }),
  );

  it.effect("bucket failures surface as StorageError", () =>
    Effect.gen(function* () {
      // oxlint-disable-next-line executor/no-double-cast -- test double: only the slice the store calls is implemented
      const failing = {
        get: async () => {
          // oxlint-disable-next-line executor/no-try-catch-or-throw -- test double simulating a bucket outage
          throw { name: "R2Error", message: "bucket unavailable" };
        },
      } as unknown as R2Bucket;
      const store = makeR2BlobStore(failing);
      const err = yield* store.get("ns", "k").pipe(Effect.flip);
      expect(err).toBeInstanceOf(StorageError);
    }),
  );

  it.effect("works behind pluginBlobStore owner partitioning", () =>
    Effect.gen(function* () {
      const { bucket } = makeFakeBucket();
      const store = makeR2BlobStore(bucket);
      const plugin = pluginBlobStore(store, { org: "o:t1", user: "u:t1:s1" }, "openapi");

      yield* plugin.put("spec/h1", "org-spec", { owner: "org" });
      expect(yield* plugin.get("spec/h1")).toBe("org-spec");

      yield* plugin.put("spec/h1", "user-spec", { owner: "user" });
      expect(yield* plugin.get("spec/h1")).toBe("user-spec");
    }),
  );
});
