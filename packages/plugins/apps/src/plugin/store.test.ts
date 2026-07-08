import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  makeInMemoryBlobStore,
  pluginBlobStore,
  type PluginStorageCollectionDefinition,
  type PluginStorageEntry,
  type PluginStorageFacade,
} from "@executor-js/sdk";

import type { AppDescriptor } from "../pipeline/descriptor";
import { descriptorCollection, makeAppsStore, toolCollection } from "./store";

const entry = <T>(input: {
  owner: "org" | "user";
  collection: string;
  key: string;
  data: T;
}): PluginStorageEntry<T> => ({
  id: `${input.collection}:${input.key}`,
  owner: input.owner,
  pluginId: "apps",
  collection: input.collection,
  key: input.key,
  data: input.data,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const makeMemoryPluginStorage = (): PluginStorageFacade => {
  const rows = new Map<string, PluginStorageEntry<unknown>>();
  const rowKey = (owner: string, collection: string, key: string) =>
    `${owner}:${collection}:${key}`;
  const put = (input: {
    readonly owner: "org" | "user";
    readonly collection: string;
    readonly key: string;
    readonly data: object;
  }) =>
    Effect.sync(() => {
      const next = entry({
        owner: input.owner,
        collection: input.collection,
        key: input.key,
        data: input.data,
      });
      rows.set(rowKey(input.owner, input.collection, input.key), next);
      return next;
    });
  return {
    collection: <const TDefinition extends PluginStorageCollectionDefinition>(
      definition: TDefinition,
    ) => ({
      get: ({ key }) =>
        Effect.sync(() => {
          for (const row of rows.values()) {
            if (row.collection === definition.name && row.key === key) return row as never;
          }
          return null;
        }),
      getForOwner: ({ owner, key }) =>
        Effect.sync(
          () => (rows.get(rowKey(owner, definition.name, key)) as never | undefined) ?? null,
        ),
      list: ({ keyPrefix } = {}) =>
        Effect.sync(
          () =>
            [...rows.values()].filter(
              (row) =>
                row.collection === definition.name &&
                (keyPrefix === undefined || row.key.startsWith(keyPrefix)),
            ) as never,
        ),
      put: (input) => put({ ...input, collection: definition.name }) as never,
      query: (input = {}) =>
        Effect.sync(() => {
          let out = [...rows.values()].filter((row) => row.collection === definition.name);
          if (input.where) {
            out = out.filter((row) =>
              Object.entries(input.where ?? {}).every(([field, expected]) => {
                const actual = (row.data as Record<string, unknown>)[field];
                return typeof expected === "object" && expected !== null && "eq" in expected
                  ? actual === expected.eq
                  : actual === expected;
              }),
            );
          }
          return (input.limit ? out.slice(0, input.limit) : out) as never;
        }),
      count: () => Effect.sync(() => 0),
      remove: ({ owner, key }) =>
        Effect.sync(() => {
          rows.delete(rowKey(owner, definition.name, key));
        }),
    }),
    get: ({ collection, key }) =>
      Effect.sync(() => {
        for (const row of rows.values()) {
          if (row.collection === collection && row.key === key) return row as never;
        }
        return null;
      }),
    getForOwner: ({ owner, collection, key }) =>
      Effect.sync(() => (rows.get(rowKey(owner, collection, key)) as never | undefined) ?? null),
    list: ({ collection, keyPrefix }) =>
      Effect.sync(
        () =>
          [...rows.values()].filter(
            (row) =>
              row.collection === collection &&
              (keyPrefix === undefined || row.key.startsWith(keyPrefix)),
          ) as never,
      ),
    put: (input) => put(input as never) as never,
    putMany: ({ owner, entries }) =>
      Effect.sync(() => {
        for (const item of entries) {
          const next = entry({
            owner,
            collection: item.collection,
            key: item.key,
            data: item.data,
          });
          rows.set(rowKey(owner, item.collection, item.key), next);
        }
      }),
    remove: ({ owner, collection, key }) =>
      Effect.sync(() => {
        rows.delete(rowKey(owner, collection, key));
      }),
    removeMany: ({ owner, entries }) =>
      Effect.sync(() => {
        for (const item of entries) rows.delete(rowKey(owner, item.collection, item.key));
      }),
  };
};

const descriptor = (tools: readonly AppDescriptor["tools"][number][]): AppDescriptor => ({
  version: 6,
  app: "crm",
  sourceRef: "sha-1",
  descriptorKey: "descriptor",
  publishedAt: 1,
  toolchain: {
    bundler: { name: "esbuild", version: "0" },
    executor: { name: "test", version: "0" },
    target: "es2022",
  },
  tools,
  workflows: [],
  ui: [],
  skills: [],
  skipped: [],
});

const tool = (name: string): AppDescriptor["tools"][number] => ({
  name,
  sourcePath: `tools/${name}.ts`,
  bundleKey: `bundle:${name}`,
  source: { path: `tools/${name}.ts`, sourceHash: name },
  description: name,
  integrations: {},
});

describe("apps store", () => {
  it.effect("tombstones removed tools", () =>
    Effect.gen(function* () {
      const store = makeAppsStore({
        blobs: pluginBlobStore(makeInMemoryBlobStore(), { org: "tenant", user: null }, "apps"),
        pluginStorage: makeMemoryPluginStorage(),
      });
      yield* store.putPublished(descriptor([tool("first"), tool("second")]), "org", null);
      yield* store.putPublished(descriptor([tool("first")]), "org", "sha-1");
      const active = yield* store.listActiveTools();
      expect(active.map((item) => item.name)).toEqual(["first"]);
    }),
  );

  it.effect("keeps owner blob partitions isolated", () =>
    Effect.gen(function* () {
      const blobStore = makeInMemoryBlobStore();
      const orgStore = makeAppsStore({
        blobs: pluginBlobStore(blobStore, { org: "tenant-a", user: null }, "apps"),
        pluginStorage: makeMemoryPluginStorage(),
      });
      const otherStore = makeAppsStore({
        blobs: pluginBlobStore(blobStore, { org: "tenant-b", user: null }, "apps"),
        pluginStorage: makeMemoryPluginStorage(),
      });
      const key = yield* orgStore.putBlob("same app", "org");
      expect(yield* orgStore.getBlob(key)).toBe("same app");
      expect(yield* otherStore.getBlob(key)).toBeNull();
    }),
  );

  it("declares plugin storage collections", () => {
    expect(descriptorCollection.name).toBe("apps_descriptors");
    expect(toolCollection.name).toBe("apps_tools");
  });
});
