import { Effect, Layer } from "effect";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import type { KVNamespace } from "@cloudflare/workers-types";

const KV_DELETE_CONCURRENCY = 50;

const storeError = (method: string, key: string | undefined, cause: unknown) =>
  new KeyValueStore.KeyValueStoreError({
    method,
    key,
    message: `Cloudflare KV ${method} failed`,
    cause,
  });

const listKeys = async (kv: KVNamespace): Promise<ReadonlyArray<string>> => {
  const keys: Array<string> = [];
  let cursor: string | undefined;

  do {
    const page = await kv.list({ cursor });
    keys.push(...page.keys.map((key) => key.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);

  return keys;
};

const deleteKeys = async (kv: KVNamespace, keys: ReadonlyArray<string>): Promise<void> => {
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
        catch: (cause) => storeError("get", key, cause),
      }),
    set: (key, value) =>
      Effect.tryPromise({
        try: () => kv.put(key, value),
        catch: (cause) => storeError("set", key, cause),
      }),
    remove: (key) =>
      Effect.tryPromise({
        try: () => kv.delete(key),
        catch: (cause) => storeError("remove", key, cause),
      }),
    clear: Effect.tryPromise({
      try: async () => deleteKeys(kv, await listKeys(kv)),
      catch: (cause) => storeError("clear", undefined, cause),
    }),
    size: Effect.tryPromise({
      try: async () => (await listKeys(kv)).length,
      catch: (cause) => storeError("size", undefined, cause),
    }),
  });

export const layerCloudflareKeyValueStore = (
  kv: KVNamespace,
): Layer.Layer<KeyValueStore.KeyValueStore> =>
  Layer.succeed(KeyValueStore.KeyValueStore, makeCloudflareKeyValueStore(kv));
