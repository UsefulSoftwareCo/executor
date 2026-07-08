// ---------------------------------------------------------------------------
// Effect KeyValueStore over a Cloudflare KV namespace — the durable backend
// for `executor.cache` on the Cloudflare hosts. The SDK owns the cache seam
// (`ExecutorConfig.cache`, with an in-memory fallback); this binding lives
// here so the SDK stays platform-agnostic, mirroring blob-store.ts for R2.
//
// KV is eventually consistent across edge locations — fine for a cache
// (consumers must treat entries as best-effort), wrong for anything needing
// read-after-write. `size`/`clear` paginate the whole namespace and exist for
// interface completeness; production consumers should not call them on a
// namespace of any size.
// ---------------------------------------------------------------------------

import { Effect, Layer } from "effect";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import type { KVNamespace } from "@cloudflare/workers-types";

const KV_DELETE_CONCURRENCY = 50;

const storeError = (method: string, key: string | undefined) => (cause: unknown) =>
  new KeyValueStore.KeyValueStoreError({
    method,
    ...(key !== undefined ? { key } : {}),
    message: `Cloudflare KV ${method} failed`,
    cause,
  });

const listAllKeys = async (kv: KVNamespace): Promise<readonly string[]> => {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list(cursor === undefined ? {} : { cursor });
    keys.push(...page.keys.map((key) => key.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);
  return keys;
};

const deleteAllKeys = async (kv: KVNamespace, keys: readonly string[]): Promise<void> => {
  for (let index = 0; index < keys.length; index += KV_DELETE_CONCURRENCY) {
    await Promise.all(
      keys.slice(index, index + KV_DELETE_CONCURRENCY).map((key) => kv.delete(key)),
    );
  }
};

export const makeCloudflareKeyValueStore = (kv: KVNamespace): KeyValueStore.KeyValueStore =>
  KeyValueStore.makeStringOnly({
    get: (key) =>
      Effect.tryPromise({
        try: async () => (await kv.get(key)) ?? undefined,
        catch: storeError("get", key),
      }),
    set: (key, value) =>
      Effect.tryPromise({
        try: () => kv.put(key, value),
        catch: storeError("set", key),
      }),
    remove: (key) =>
      Effect.tryPromise({
        try: () => kv.delete(key),
        catch: storeError("remove", key),
      }),
    clear: Effect.tryPromise({
      try: async (signal) => {
        void signal;
        await deleteAllKeys(kv, await listAllKeys(kv));
      },
      catch: storeError("clear", undefined),
    }),
    size: Effect.tryPromise({
      try: async () => (await listAllKeys(kv)).length,
      catch: storeError("size", undefined),
    }),
  });

/** Boot-layer form: provide the KV namespace as the ambient
 *  `KeyValueStore.KeyValueStore` service `makeScopedExecutor` reads
 *  optionally and threads into `createExecutor({ cache })`. */
export const layerCloudflareKeyValueStore = (
  kv: KVNamespace,
): Layer.Layer<KeyValueStore.KeyValueStore> =>
  Layer.succeed(KeyValueStore.KeyValueStore, makeCloudflareKeyValueStore(kv));
