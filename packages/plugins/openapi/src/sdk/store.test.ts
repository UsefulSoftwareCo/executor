import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import {
  Subject,
  Tenant,
  type PluginBlobStore,
  type PluginStorageEntry,
  type PluginStorageFacade,
  type PluginStorageListInput,
  type StorageDeps,
} from "@executor-js/sdk/core";

import { makeDefaultOpenapiStore } from "./store";
import { OperationBinding } from "./types";

const binding = () =>
  OperationBinding.make({
    method: "get",
    servers: [],
    pathTemplate: "/things",
    parameters: [],
    requestBody: Option.none(),
    responseBody: Option.none(),
  });

/** In-memory `PluginStorageFacade` for testing the openapi store in isolation,
 *  honoring `keyPrefix`/`keyPrefixes` the same way the real facade does and
 *  recording every `list` input so tests can assert how the scan was narrowed. */
const makeInMemoryPluginStorage = () => {
  const rows = new Map<string, PluginStorageEntry>();
  const capturedKeys: string[] = [];
  const listInputs: PluginStorageListInput[] = [];
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
  const prefixesOf = (input: PluginStorageListInput): readonly string[] | undefined => {
    const all = [
      ...(input.keyPrefix === undefined ? [] : [input.keyPrefix]),
      ...(input.keyPrefixes ?? []),
    ];
    return all.length === 0 ? undefined : all;
  };
  const pluginStorage: PluginStorageFacade = {
    collection: () => ({
      get: () => Effect.succeed(null),
      getForOwner: () => Effect.succeed(null),
      list: () => Effect.succeed([]),
      put: (input) =>
        Effect.succeed(
          makeEntry({ owner: input.owner, collection: "unused", key: input.key, data: input.data }),
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
    list: <T = unknown>(input: PluginStorageListInput) =>
      Effect.sync(() => {
        listInputs.push(input);
        const prefixes = prefixesOf(input);
        return [...rows.values()].filter(
          (row) =>
            row.collection === input.collection &&
            (prefixes === undefined || prefixes.some((prefix) => row.key.startsWith(prefix))),
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
  return { pluginStorage, rows, capturedKeys, listInputs, storageKey };
};

const blobs: PluginBlobStore = {
  get: () => Effect.succeed(null),
  put: () => Effect.void,
  delete: () => Effect.void,
  has: () => Effect.succeed(false),
};

const makeStore = (pluginStorage: PluginStorageFacade) =>
  makeDefaultOpenapiStore({
    owner: { tenant: Tenant.make("tenant"), subject: Subject.make("subject") },
    blobs,
    pluginStorage,
  } satisfies StorageDeps);

describe("OpenAPI operation store", () => {
  it.effect("bounds operation storage keys while preserving tool-name lookup", () =>
    Effect.gen(function* () {
      const { pluginStorage, capturedKeys } = makeInMemoryPluginStorage();
      const store = makeStore(pluginStorage);
      const toolName = `users.${"veryLongSegment.".repeat(40)}get`;

      yield* store.putOperations("microsoft_graph", [
        {
          integration: "microsoft_graph",
          toolName,
          binding: OperationBinding.make({
            method: "get",
            servers: [],
            pathTemplate: "/users/{userId}/messages",
            parameters: [],
            requestBody: Option.none(),
            responseBody: Option.none(),
          }),
        },
      ]);

      expect(capturedKeys).toHaveLength(1);
      expect(capturedKeys[0]!.length).toBeLessThanOrEqual(255);
      expect(capturedKeys[0]).not.toContain(toolName);

      const operation = yield* store.getOperation("microsoft_graph", toolName);
      expect(operation?.toolName).toBe(toolName);
      expect(operation?.binding.pathTemplate).toBe("/users/{userId}/messages");
    }),
  );

  it.effect("listOperations returns only the requested integration's operations", () =>
    Effect.gen(function* () {
      const { pluginStorage } = makeInMemoryPluginStorage();
      const store = makeStore(pluginStorage);

      yield* store.putOperations("github", [
        { integration: "github", toolName: "issues.list", binding: binding() },
        { integration: "github", toolName: "repos.get", binding: binding() },
      ]);
      yield* store.putOperations("slack", [
        { integration: "slack", toolName: "chat.post", binding: binding() },
      ]);

      const github = yield* store.listOperations("github");
      expect(github.map((op) => op.toolName).sort()).toEqual(["issues.list", "repos.get"]);

      const slack = yield* store.listOperations("slack");
      expect(slack.map((op) => op.toolName)).toEqual(["chat.post"]);
    }),
  );

  it.effect("listOperations narrows the scan by integration via keyPrefixes", () =>
    Effect.gen(function* () {
      const { pluginStorage, listInputs } = makeInMemoryPluginStorage();
      const store = makeStore(pluginStorage);

      yield* store.putOperations("github", [
        { integration: "github", toolName: "issues.list", binding: binding() },
      ]);
      listInputs.length = 0;

      yield* store.listOperations("github");

      // The store must push integration-scoped prefixes (v2 hashed + legacy
      // plaintext) to the storage layer instead of scanning the whole
      // collection unprefixed.
      expect(listInputs).toHaveLength(1);
      const prefixes = listInputs[0]!.keyPrefixes ?? [];
      expect(prefixes.some((p) => p.startsWith("op."))).toBe(true);
      expect(prefixes).toContain("github.");
      // No bare unprefixed full-collection scan.
      expect(listInputs[0]!.keyPrefix === undefined && prefixes.length === 0).toBe(false);
    }),
  );

  it.effect("listOperations still returns legacy-keyed rows for the integration", () =>
    Effect.gen(function* () {
      const { pluginStorage, rows, storageKey } = makeInMemoryPluginStorage();
      const store = makeStore(pluginStorage);

      // Seed a v2 row through the store, then relocate it under the legacy
      // plaintext key (`<integration>.<tool>`) to simulate un-migrated data.
      yield* store.putOperations("github", [
        { integration: "github", toolName: "legacy.tool", binding: binding() },
      ]);
      const v2Entry = [...rows.entries()].find(([, row]) => row.collection === "operation");
      expect(v2Entry).toBeDefined();
      const [v2StorageKey, entry] = v2Entry!;
      rows.delete(v2StorageKey);
      const legacyKey = "github.legacy.tool";
      rows.set(storageKey("operation", legacyKey), { ...entry, key: legacyKey, id: legacyKey });

      const ops = yield* store.listOperations("github");
      expect(ops.map((op) => op.toolName)).toEqual(["legacy.tool"]);
    }),
  );
});
