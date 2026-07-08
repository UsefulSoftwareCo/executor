import { Data, Effect } from "effect";
import {
  definePluginStorageCollection,
  sha256Hex,
  type Owner,
  type PluginBlobStore,
  type PluginStorageFacade,
  type StorageFailure,
} from "@executor-js/sdk";

import type { AppDescriptor } from "../pipeline/descriptor";
import type { SyncDiagnostic } from "../source/app-source";

export class AppPublishConflictError extends Data.TaggedError("AppPublishConflictError")<{
  readonly app: string;
  readonly expectedSourceRef: string | null;
  readonly actualSourceRef: string | null;
}> {}

export const descriptorCollection = definePluginStorageCollection("apps_descriptors", {
  Type: {} as {
    readonly app: string;
    readonly sourceRef: string;
    readonly descriptorKey: string;
    readonly publishedAt: number;
    readonly toolchain: AppDescriptor["toolchain"];
  },
});

export const toolCollection = definePluginStorageCollection(
  "apps_tools",
  {
    Type: {} as {
      readonly app: string;
      readonly name: string;
      readonly sourceRef: string;
      readonly descriptorKey: string;
      readonly bundleKey: string;
      readonly description: string;
      readonly inputSchema?: unknown;
      readonly outputSchema?: unknown;
      readonly integrations: AppDescriptor["tools"][number]["integrations"];
      readonly annotations?: AppDescriptor["tools"][number]["annotations"];
      readonly tombstoned: boolean;
      readonly updatedAt: number;
    },
  },
  { indexes: ["app", "name", "tombstoned"] },
);

export const sourceCollection = definePluginStorageCollection(
  "apps_sources",
  {
    Type: {} as AppSourceRecord,
  },
  { indexes: ["kind", "app"] },
);

export type AppSourceKind = "git" | "local-directory";

export type AppSourceConfig =
  | {
      readonly kind: "git";
      readonly url: string;
      readonly ref?: string;
      readonly tokenProvider?: string;
      readonly tokenItemId?: string;
    }
  | {
      readonly kind: "local-directory";
      readonly path: string;
    };

export interface AppSourceRecord {
  readonly slug: string;
  readonly app: string;
  readonly kind: AppSourceKind;
  readonly config: AppSourceConfig;
  readonly sourceRef?: string;
  readonly description?: string;
  readonly status:
    | { readonly type: "pending" }
    | { readonly type: "published"; readonly at: number; readonly tools: readonly string[] }
    | { readonly type: "up-to-date"; readonly at: number; readonly tools: readonly string[] }
    | { readonly type: "failed"; readonly at: number; readonly errors: readonly SyncDiagnostic[] };
  readonly updatedAt: number;
}

export interface AppsStore {
  readonly putBlob: (body: string, owner: Owner) => Effect.Effect<string, StorageFailure>;
  readonly getBlob: (key: string) => Effect.Effect<string | null, StorageFailure>;
  readonly getDescriptorRecord: (app: string) => Effect.Effect<
    {
      readonly sourceRef: string;
      readonly descriptorKey: string;
    } | null,
    StorageFailure
  >;
  readonly putPublished: (
    descriptor: AppDescriptor,
    descriptorKey: string,
    owner: Owner,
    expectedSourceRef: string | null,
  ) => Effect.Effect<void, StorageFailure | AppPublishConflictError>;
  readonly removePublished: (app: string, owner: Owner) => Effect.Effect<void, StorageFailure>;
  readonly listActiveTools: () => Effect.Effect<
    readonly (AppDescriptor["tools"][number] & { readonly app: string })[],
    StorageFailure
  >;
  readonly getTool: (name: string) => Effect.Effect<
    {
      readonly app: string;
      readonly name: string;
      readonly bundleKey: string;
      readonly description: string;
      readonly inputSchema?: unknown;
      readonly outputSchema?: unknown;
      readonly integrations: AppDescriptor["tools"][number]["integrations"];
      readonly annotations?: AppDescriptor["tools"][number]["annotations"];
    } | null,
    StorageFailure
  >;
  readonly getToolForApp: (
    app: string,
    name: string,
  ) => Effect.Effect<
    {
      readonly app: string;
      readonly name: string;
      readonly bundleKey: string;
      readonly description: string;
      readonly inputSchema?: unknown;
      readonly outputSchema?: unknown;
      readonly integrations: AppDescriptor["tools"][number]["integrations"];
      readonly annotations?: AppDescriptor["tools"][number]["annotations"];
    } | null,
    StorageFailure
  >;
  readonly putSource: (
    record: AppSourceRecord,
    owner: Owner,
  ) => Effect.Effect<void, StorageFailure>;
  readonly listSources: () => Effect.Effect<readonly AppSourceRecord[], StorageFailure>;
  readonly getSource: (slug: string) => Effect.Effect<AppSourceRecord | null, StorageFailure>;
  readonly removeSource: (slug: string, owner: Owner) => Effect.Effect<void, StorageFailure>;
}

interface PutManyEntry {
  readonly collection: string;
  readonly key: string;
  readonly data: unknown;
}

export const makeAppsStore = (input: {
  readonly blobs: PluginBlobStore;
  readonly pluginStorage: PluginStorageFacade;
}): AppsStore => {
  const descriptors = input.pluginStorage.collection(descriptorCollection);
  const tools = input.pluginStorage.collection(toolCollection);
  const sources = input.pluginStorage.collection(sourceCollection);
  const keyForTool = (app: string, name: string) => `${app}:${name}`;
  return {
    putBlob: (body, owner) =>
      sha256Hex(body).pipe(
        Effect.flatMap((hash) =>
          input.blobs.put(`apps/${hash}`, body, { owner }).pipe(Effect.as(`apps/${hash}`)),
        ),
      ),
    getBlob: (key) => input.blobs.get(key),
    getDescriptorRecord: (app) =>
      descriptors.get({ key: app }).pipe(
        Effect.map((entry) =>
          entry
            ? {
                sourceRef: entry.data.sourceRef,
                descriptorKey: entry.data.descriptorKey,
              }
            : null,
        ),
      ),
    putPublished: (descriptor, descriptorKey, owner, expectedSourceRef) =>
      Effect.gen(function* () {
        const current = yield* descriptors.get({ key: descriptor.app });
        const actualSourceRef = current?.data.sourceRef ?? null;
        if (actualSourceRef !== expectedSourceRef) {
          return yield* new AppPublishConflictError({
            app: descriptor.app,
            expectedSourceRef,
            actualSourceRef,
          });
        }
        const now = descriptor.publishedAt;
        const existing = yield* tools.query({ where: { app: descriptor.app } });
        const activeNames = new Set(descriptor.tools.map((tool) => tool.name));
        const entries: PutManyEntry[] = descriptor.tools.map((tool) => ({
          collection: toolCollection.name,
          key: keyForTool(descriptor.app, tool.name),
          data: {
            app: descriptor.app,
            name: tool.name,
            sourceRef: descriptor.sourceRef,
            descriptorKey,
            bundleKey: tool.bundleKey,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            integrations: tool.integrations,
            annotations: tool.annotations,
            tombstoned: false,
            updatedAt: now,
          },
        }));
        for (const entry of existing) {
          if (!activeNames.has(entry.data.name) && !entry.data.tombstoned) {
            entries.push({
              collection: toolCollection.name,
              key: entry.key,
              data: { ...entry.data, tombstoned: true, updatedAt: now },
            });
          }
        }
        yield* input.pluginStorage.putMany({ owner, entries });
        yield* descriptors.put({
          owner,
          key: descriptor.app,
          data: {
            app: descriptor.app,
            sourceRef: descriptor.sourceRef,
            descriptorKey,
            publishedAt: descriptor.publishedAt,
            toolchain: descriptor.toolchain,
          },
        });
      }),
    removePublished: (app, owner) =>
      Effect.gen(function* () {
        const existing = yield* tools.query({ where: { app } });
        const now = Date.now();
        const entries: PutManyEntry[] = existing
          .filter((entry) => !entry.data.tombstoned)
          .map((entry) => ({
            collection: toolCollection.name,
            key: entry.key,
            data: { ...entry.data, tombstoned: true, updatedAt: now },
          }));
        if (entries.length > 0) {
          yield* input.pluginStorage.putMany({ owner, entries });
        }
        yield* descriptors.remove({ owner, key: app });
      }),
    listActiveTools: () =>
      tools.query({ where: { tombstoned: false } }).pipe(
        Effect.map((entries) =>
          entries.map((entry) => ({
            app: entry.data.app,
            name: entry.data.name,
            sourcePath: "",
            source: { path: "", sourceHash: "" },
            bundleKey: entry.data.bundleKey,
            description: entry.data.description,
            integrations: entry.data.integrations,
            inputSchema: entry.data.inputSchema,
            outputSchema: entry.data.outputSchema,
            annotations: entry.data.annotations,
          })),
        ),
      ),
    getTool: (name) =>
      tools.query({ where: { name, tombstoned: false }, limit: 1 }).pipe(
        Effect.map((entries) => {
          const entry = entries[0];
          return entry
            ? {
                app: entry.data.app,
                name: entry.data.name,
                bundleKey: entry.data.bundleKey,
                description: entry.data.description,
                inputSchema: entry.data.inputSchema,
                outputSchema: entry.data.outputSchema,
                integrations: entry.data.integrations,
                annotations: entry.data.annotations,
              }
            : null;
        }),
      ),
    getToolForApp: (app, name) =>
      tools.query({ where: { app, name, tombstoned: false }, limit: 1 }).pipe(
        Effect.map((entries) => {
          const entry = entries[0];
          return entry
            ? {
                app: entry.data.app,
                name: entry.data.name,
                bundleKey: entry.data.bundleKey,
                description: entry.data.description,
                inputSchema: entry.data.inputSchema,
                outputSchema: entry.data.outputSchema,
                integrations: entry.data.integrations,
                annotations: entry.data.annotations,
              }
            : null;
        }),
      ),
    putSource: (record, owner) =>
      sources.put({ owner, key: record.slug, data: record }).pipe(Effect.asVoid),
    listSources: () =>
      sources.list().pipe(Effect.map((entries) => entries.map((entry) => entry.data))),
    getSource: (slug) =>
      sources.get({ key: slug }).pipe(Effect.map((entry) => entry?.data ?? null)),
    removeSource: (slug, owner) => sources.remove({ owner, key: slug }),
  };
};
