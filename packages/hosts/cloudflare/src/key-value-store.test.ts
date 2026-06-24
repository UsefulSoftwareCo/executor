import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { KVNamespace } from "@cloudflare/workers-types";

import { makeCloudflareKeyValueStore } from "./key-value-store";

const makeFakeKv = (
  pageSize: number,
): {
  readonly kv: KVNamespace;
  readonly values: Map<string, string>;
  readonly maxConcurrentDeletes: () => number;
} => {
  const values = new Map<string, string>();
  let activeDeletes = 0;
  let maxActiveDeletes = 0;

  // oxlint-disable-next-line executor/no-double-cast -- test double: only the KV slice the adapter calls is implemented
  const kv = {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      activeDeletes += 1;
      maxActiveDeletes = Math.max(maxActiveDeletes, activeDeletes);
      await new Promise((resolve) => setTimeout(resolve, 0));
      values.delete(key);
      activeDeletes -= 1;
    },
    list: async (options?: { readonly cursor?: string }) => {
      const offset = options?.cursor === undefined ? 0 : Number(options.cursor);
      const keys = [...values.keys()].sort().slice(offset, offset + pageSize);
      const nextOffset = offset + pageSize;
      const listComplete = nextOffset >= values.size;

      return {
        keys: keys.map((name) => ({ name })),
        list_complete: listComplete,
        cursor: listComplete ? "" : String(nextOffset),
      };
    },
  } as unknown as KVNamespace;

  return {
    kv,
    values,
    maxConcurrentDeletes: () => maxActiveDeletes,
  };
};

describe("makeCloudflareKeyValueStore", () => {
  it.effect("round-trips string values", () =>
    Effect.gen(function* () {
      const { kv } = makeFakeKv(10);
      const store = makeCloudflareKeyValueStore(kv);

      yield* store.set("a", "value");
      expect(yield* store.get("a")).toBe("value");

      yield* store.remove("a");
      expect(yield* store.get("a")).toBeUndefined();
    }),
  );

  it.effect("counts paginated keys", () =>
    Effect.gen(function* () {
      const { values, kv } = makeFakeKv(2);
      values.set("a", "1");
      values.set("b", "2");
      values.set("c", "3");

      const store = makeCloudflareKeyValueStore(kv);
      expect(yield* store.size).toBe(3);
    }),
  );

  it.effect("clears paginated keys in bounded parallel batches", () =>
    Effect.gen(function* () {
      const { values, kv, maxConcurrentDeletes } = makeFakeKv(25);
      for (let index = 0; index < 75; index += 1) {
        values.set(`key-${index.toString().padStart(2, "0")}`, String(index));
      }

      const store = makeCloudflareKeyValueStore(kv);
      yield* store.clear;

      expect(values.size).toBe(0);
      expect(maxConcurrentDeletes()).toBeGreaterThan(1);
      expect(maxConcurrentDeletes()).toBeLessThanOrEqual(50);
    }),
  );
});
