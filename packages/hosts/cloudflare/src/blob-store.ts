// ---------------------------------------------------------------------------
// BlobStore over a Cloudflare R2 bucket — the object-store backend for the
// SDK's blob seam on the Cloudflare hosts. The SDK defines only the
// `BlobStore` contract (plus its FumaDB/in-memory defaults); this R2 binding
// lives here so the SDK stays platform-agnostic.
//
// Object name: `${namespace}/${key}`. Unambiguous because a namespace is
// always `partition/pluginId` (exactly one slash; partitions use `:// separators, plugin ids contain no slash), so the first two segments always
// recover the namespace and the rest is the key.
//
// Unlike `makeFumaBlobStore`, writes do NOT participate in FumaDB
// transactions — a rolled-back transaction leaves the blob behind. Callers
// should use idempotent (content-derived) keys so orphaned writes are
// harmless and re-puts are no-ops in effect.
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import type { R2Bucket } from "@cloudflare/workers-types";

import { StorageError, type BlobStore } from "@executor-js/sdk";

const objectName = (namespace: string, key: string): string => `${namespace}/${key}`;

const storeError = (op: string) => (cause: unknown) =>
  new StorageError({ message: `R2 blob ${op} failed`, cause });

export const makeR2BlobStore = (bucket: R2Bucket): BlobStore => {
  // Claims for compareAndDelete: at most one in-flight claim per object in
  // this isolate. JavaScript is single-threaded per isolate, so the
  // synchronous has+add below is atomic and the only interleaving risk is
  // between the await points of the head+delete pair — the claim gate
  // closes exactly that window (a second fiber sees the claim and observes
  // false without touching R2). Cross-isolate races remain
  // last-writer-wins: R2 offers no conditional delete. The caller pattern
  // (single consume per approval; idempotent re-consume returns null)
  // tolerates that residual, same as the orphaned-write caveat above.
  const claims = new Set<string>();

  return {
    get: (namespace, key) =>
      Effect.tryPromise({
        try: async () => {
          const object = await bucket.get(objectName(namespace, key));
          return object == null ? null : await object.text();
        },
        catch: storeError("get"),
      }),
    // R2 has no multi-get; fetch the (at most two — user + org partition)
    // namespaces concurrently.
    getMany: (namespaces, key) =>
      Effect.tryPromise({
        try: async () => {
          const hits = new Map<string, string>();
          await Promise.all(
            namespaces.map(async (namespace) => {
              const object = await bucket.get(objectName(namespace, key));
              if (object != null) hits.set(namespace, await object.text());
            }),
          );
          return hits;
        },
        catch: storeError("getMany"),
      }),
    put: (namespace, key, value) =>
      Effect.tryPromise({
        try: async () => {
          await bucket.put(objectName(namespace, key), value);
        },
        catch: storeError("put"),
      }),
    delete: (namespace, key) =>
      Effect.tryPromise({
        try: () => bucket.delete(objectName(namespace, key)),
        catch: storeError("delete"),
      }),
    has: (namespace, key) =>
      Effect.tryPromise({
        try: async () => (await bucket.head(objectName(namespace, key))) != null,
        catch: storeError("has"),
      }),
    compareAndDelete: (namespace, key) => {
      const name = objectName(namespace, key);
      // Gate 1: isolate-level claim, atomic (synchronous has+add).
      if (claims.has(name)) return Effect.succeed(false);
      claims.add(name);
      return Effect.tryPromise({
        try: async () => {
          // Gate 2: existence check at delete time. An absent object means
          // someone else removed it — this caller loses.
          const head = await bucket.head(name);
          if (head == null) return false;
          await bucket.delete(name);
          return true;
        },
        catch: storeError("compareAndDelete"),
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            claims.delete(name);
          }),
        ),
      );
    },
  };
};
