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
    readonly tenant: string;
    readonly scope: string;
    readonly snapshotId: string;
    readonly descriptor: AppDescriptor;
    readonly publishedAt: number;
  },
});

export const scopeConnectionCollection = definePluginStorageCollection("apps_scope_connection", {
  Type: {} as {
    readonly tenant: string;
    readonly connectionName: string;
    readonly scope: string;
  },
});

export interface AppsStore {
  readonly putDescriptor: (
    tenant: string,
    owner: "org" | "user",
    descriptor: AppDescriptor,
  ) => Effect.Effect<void, StorageFailure>;
  readonly getDescriptor: (
    tenant: string,
    scope: string,
  ) => Effect.Effect<AppDescriptor | null, StorageFailure>;
  readonly putScopeForConnection: (
    tenant: string,
    connectionName: string,
    scope: string,
  ) => Effect.Effect<void, StorageFailure>;
  readonly getScopeForConnection: (
    tenant: string,
    connectionName: string,
  ) => Effect.Effect<string | null, StorageFailure>;
}

export interface AppsStoreDeps {
  readonly pluginStorage: PluginStorageFacade;
}

export const makeAppsStore = (deps: AppsStoreDeps): AppsStore => {
  const descriptors = deps.pluginStorage.collection(descriptorCollection);
  const scopeConnections = deps.pluginStorage.collection(scopeConnectionCollection);
  // Tenant is now part of apps storage keys. The apps subsystem had not shipped
  // before this key shape, so no migration from the old scope-only keys is needed.
  const keyFor = (tenant: string, key: string): string => `${tenant}:${key}`;
  return {
    putScopeForConnection: (tenant, connectionName, scope) =>
      scopeConnections
        .put({
          owner: "org",
          key: keyFor(tenant, connectionName),
          data: { tenant, connectionName, scope },
        })
        .pipe(Effect.asVoid),
    getScopeForConnection: (tenant, connectionName) =>
      scopeConnections
        .get({ key: keyFor(tenant, connectionName) })
        .pipe(Effect.map((entry) => entry?.data.scope ?? null)),
    putDescriptor: (tenant, owner, descriptor) =>
      descriptors
        .put({
          owner,
          key: keyFor(tenant, descriptor.scope),
          data: {
            tenant,
            scope: descriptor.scope,
            snapshotId: descriptor.snapshotId,
            descriptor,
            publishedAt: Date.now(),
          },
        })
        .pipe(Effect.asVoid),
    getDescriptor: (tenant, scope) =>
      descriptors
        .get({ key: keyFor(tenant, scope) })
        .pipe(Effect.map((entry) => entry?.data.descriptor ?? null)),
  };
};
