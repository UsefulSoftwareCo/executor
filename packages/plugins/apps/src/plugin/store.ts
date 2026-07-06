import { Effect } from "effect";

import {
  definePluginStorageCollection,
  type PluginStorageFacade,
  type StorageFailure,
} from "@executor-js/sdk";

import type { AppDescriptor } from "../pipeline/descriptor";

// ---------------------------------------------------------------------------
// AppsStore: descriptor pointer persistence and connection-to-scope mapping.
// ---------------------------------------------------------------------------

export const descriptorCollection = definePluginStorageCollection("published_descriptor", {
  Type: {} as {
    readonly scope: string;
    readonly snapshotId: string;
    readonly descriptor: AppDescriptor;
    readonly publishedAt: number;
  },
});

export const scopeConnectionCollection = definePluginStorageCollection("apps_scope_connection", {
  Type: {} as {
    readonly connectionName: string;
    readonly scope: string;
  },
});

export interface AppsStore {
  readonly putDescriptor: (
    owner: "org" | "user",
    descriptor: AppDescriptor,
  ) => Effect.Effect<void, StorageFailure>;
  readonly getDescriptor: (scope: string) => Effect.Effect<AppDescriptor | null, StorageFailure>;
  readonly putScopeForConnection: (
    connectionName: string,
    scope: string,
  ) => Effect.Effect<void, StorageFailure>;
  readonly getScopeForConnection: (
    connectionName: string,
  ) => Effect.Effect<string | null, StorageFailure>;
}

export interface AppsStoreDeps {
  readonly pluginStorage: PluginStorageFacade;
}

export const makeAppsStore = (deps: AppsStoreDeps): AppsStore => {
  const descriptors = deps.pluginStorage.collection(descriptorCollection);
  const scopeConnections = deps.pluginStorage.collection(scopeConnectionCollection);
  return {
    putScopeForConnection: (connectionName, scope) =>
      scopeConnections
        .put({ owner: "org", key: connectionName, data: { connectionName, scope } })
        .pipe(Effect.asVoid),
    getScopeForConnection: (connectionName) =>
      scopeConnections
        .get({ key: connectionName })
        .pipe(Effect.map((entry) => entry?.data.scope ?? null)),
    putDescriptor: (owner, descriptor) =>
      descriptors
        .put({
          owner,
          key: descriptor.scope,
          data: {
            scope: descriptor.scope,
            snapshotId: descriptor.snapshotId,
            descriptor,
            publishedAt: Date.now(),
          },
        })
        .pipe(Effect.asVoid),
    getDescriptor: (scope) =>
      descriptors.get({ key: scope }).pipe(Effect.map((entry) => entry?.data.descriptor ?? null)),
  };
};
