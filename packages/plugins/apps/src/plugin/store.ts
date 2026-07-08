import { Effect } from "effect";
import {
  definePluginStorageCollection,
  sha256Hex,
  type Owner,
  type PluginBlobStore,
  type PluginStorageFacade,
  type StorageFailure,
} from "@executor-js/sdk";

import type { AppDescriptor } from "../pipeline/descriptor";

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
    owner: Owner,
  ) => Effect.Effect<void, StorageFailure>;
  readonly listActiveTools: () => Effect.Effect<
    readonly AppDescriptor["tools"][number][],
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
    putPublished: (descriptor, owner) =>
      Effect.gen(function* () {
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
            descriptorKey: descriptor.descriptorKey,
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
            descriptorKey: descriptor.descriptorKey,
            publishedAt: descriptor.publishedAt,
            toolchain: descriptor.toolchain,
          },
        });
      }),
    listActiveTools: () =>
      tools.query({ where: { tombstoned: false } }).pipe(
        Effect.map((entries) =>
          entries.map((entry) => ({
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
  };
};
