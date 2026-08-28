import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import {
  Subject,
  Tenant,
  type PluginBlobStore,
  type PluginStorageEntry,
  type PluginStorageFacade,
  type StorageDeps,
} from "@executor-js/sdk/core";

import { makeDefaultOpenapiStore } from "./store";
import { OperationBinding } from "./types";

describe("OpenAPI operation store", () => {
  it.effect("bounds operation storage keys while preserving tool-name lookup", () =>
    Effect.gen(function* () {
      const rows = new Map<string, PluginStorageEntry>();
      const capturedKeys: string[] = [];
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
            (rows.get(storageKey(input.collection, input.key)) as
              | PluginStorageEntry<T>
              | undefined) ?? null,
          ),
        getForOwner: <T = unknown>(input: { readonly collection: string; readonly key: string }) =>
          Effect.succeed(
            (rows.get(storageKey(input.collection, input.key)) as
              | PluginStorageEntry<T>
              | undefined) ?? null,
          ),
        list: <T = unknown>(input: { readonly collection: string; readonly keyPrefix?: string }) =>
          Effect.succeed(
            [...rows.values()].filter(
              (row) =>
                row.collection === input.collection &&
                (input.keyPrefix === undefined || row.key.startsWith(input.keyPrefix)),
            ) as PluginStorageEntry<T>[],
          ),
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
});
