import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

import {
  Subject,
  Tenant,
  type PluginBlobStore,
  type PluginStorageEntry,
  type PluginStorageFacade,
  type StorageDeps,
} from "@executor-js/sdk/core";

import { makeDefaultOpenapiStore, type StoredOperation } from "./store";
import { OperationBinding } from "./types";

const encodeBinding = Schema.encodeSync(OperationBinding);

const makeStoreHarness = () => {
  const rows = new Map<string, PluginStorageEntry>();
  const capturedKeys: string[] = [];
  const listedPrefixes: (string | undefined)[] = [];
  const storageKey = (collection: string, key: string) => `${collection}\0${key}`;
  const now = new Date();
  const makeEntry = <T>(input: {
    readonly owner: "org" | "user";
    readonly collection: string;
    readonly key: string;
    readonly data: T;
  }): PluginStorageEntry<T> => ({
    id: storageKey(input.collection, input.key),
    owner: input.owner,
    pluginId: "openapi",
    collection: input.collection,
    key: input.key,
    data: input.data,
    createdAt: now,
    updatedAt: now,
  });
  const pluginStorage: PluginStorageFacade = {
    collection: () => ({
      get: () => Effect.succeed(null),
      getForOwner: () => Effect.succeed(null),
      list: () => Effect.succeed([]),
      put: (input) =>
        Effect.succeed(
          makeEntry({
            owner: input.owner,
            collection: "unused",
            key: input.key,
            data: input.data,
          }),
        ),
      query: () => Effect.succeed([]),
      count: () => Effect.succeed(0),
      remove: () => Effect.void,
    }),
    get: <T = unknown>(input: { readonly collection: string; readonly key: string }) =>
      Effect.succeed(
        (rows.get(storageKey(input.collection, input.key)) as PluginStorageEntry<T> | undefined) ??
          null,
      ),
    getForOwner: <T = unknown>(input: { readonly collection: string; readonly key: string }) =>
      Effect.succeed(
        (rows.get(storageKey(input.collection, input.key)) as PluginStorageEntry<T> | undefined) ??
          null,
      ),
    list: <T = unknown>(input: { readonly collection: string; readonly keyPrefix?: string }) =>
      Effect.sync(() => {
        listedPrefixes.push(input.keyPrefix);
        return [...rows.values()].filter(
          (row) =>
            row.collection === input.collection &&
            (input.keyPrefix === undefined || row.key.startsWith(input.keyPrefix)),
        ) as PluginStorageEntry<T>[];
      }),
    put: <T = unknown>(input: {
      readonly owner: "org" | "user";
      readonly collection: string;
      readonly key: string;
      readonly data: unknown;
    }) => {
      const entry = makeEntry<T>({ ...input, data: input.data as T });
      rows.set(storageKey(input.collection, input.key), entry);
      return Effect.succeed(entry);
    },
    putMany: (input) =>
      Effect.sync(() => {
        for (const entry of input.entries) {
          capturedKeys.push(entry.key);
          rows.set(
            storageKey(entry.collection, entry.key),
            makeEntry({
              owner: input.owner,
              collection: entry.collection,
              key: entry.key,
              data: entry.data,
            }),
          );
        }
      }),
    remove: (input) =>
      Effect.sync(() => {
        rows.delete(storageKey(input.collection, input.key));
      }),
    removeMany: (input) =>
      Effect.sync(() => {
        for (const entry of input.entries) {
          rows.delete(storageKey(entry.collection, entry.key));
        }
      }),
  };
  const blobs: PluginBlobStore = {
    get: () => Effect.succeed(null),
    put: () => Effect.void,
    delete: () => Effect.void,
    has: () => Effect.succeed(false),
  };
  const store = makeDefaultOpenapiStore({
    owner: { tenant: Tenant.make("tenant"), subject: Subject.make("subject") },
    blobs,
    pluginStorage,
  } satisfies StorageDeps);
  return { store, pluginStorage, capturedKeys, listedPrefixes };
};

const operation = (integration: string, toolName: string): StoredOperation => ({
  integration,
  toolName,
  binding: OperationBinding.make({
    method: "get",
    servers: [],
    pathTemplate: `/${toolName}`,
    parameters: [],
    requestBody: Option.none(),
    responseBody: Option.none(),
  }),
});

describe("OpenAPI operation store", () => {
  it.effect("bounds operation storage keys while preserving tool-name lookup", () =>
    Effect.gen(function* () {
      const { store, capturedKeys } = makeStoreHarness();
      const toolName = `users.${"veryLongSegment.".repeat(40)}get`;

      yield* store.putOperations("microsoft_graph", [operation("microsoft_graph", toolName)]);

      expect(capturedKeys).toHaveLength(1);
      expect(capturedKeys[0]!.length).toBeLessThanOrEqual(255);
      expect(capturedKeys[0]).not.toContain(toolName);

      const stored = yield* store.getOperation("microsoft_graph", toolName);
      expect(stored?.toolName).toBe(toolName);
      expect(stored?.binding.pathTemplate).toBe(`/${toolName}`);
    }),
  );

  it.effect("lists and removes one integration's operations without reading the others", () =>
    Effect.gen(function* () {
      const { store, pluginStorage, listedPrefixes } = makeStoreHarness();
      yield* store.putOperations("github", [
        operation("github", "repos.get"),
        operation("github", "issues.list"),
      ]);
      yield* store.putOperations("stripe", [operation("stripe", "customers.list")]);
      const legacyRow = (key: string, integration: string, toolName: string) =>
        pluginStorage.put({
          owner: "org",
          collection: "operation",
          key,
          data: {
            integration,
            toolName,
            binding: encodeBinding(operation(integration, toolName).binding),
          },
        });
      // A row written under the legacy `<integration>.<tool>` key scheme.
      yield* legacyRow("github.pulls.list", "github", "pulls.list");
      // A legacy key that starts with `github.` but belongs to another
      // integration: the prefix over-matches, the result must not.
      yield* legacyRow("github.enterprise.repos.get", "github.enterprise", "repos.get");

      listedPrefixes.length = 0;
      const github = yield* store.listOperations("github");
      expect(github.map((entry) => entry.toolName).sort()).toEqual([
        "issues.list",
        "pulls.list",
        "repos.get",
      ]);
      expect(github.every((entry) => entry.integration === "github")).toBe(true);
      expect(listedPrefixes).not.toContain(undefined);

      yield* store.removeOperations("github");
      expect(yield* store.listOperations("github")).toEqual([]);
      expect((yield* store.listOperations("stripe")).map((entry) => entry.toolName)).toEqual([
        "customers.list",
      ]);
      expect(
        (yield* store.listOperations("github.enterprise")).map((entry) => entry.toolName),
      ).toEqual(["repos.get"]);
    }),
  );
});
