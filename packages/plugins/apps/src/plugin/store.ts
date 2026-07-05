import { Effect } from "effect";

import {
  definePluginStorageCollection,
  type PluginStorageFacade,
  type StorageFailure,
} from "@executor-js/sdk";

import type { AppDescriptor } from "../pipeline/descriptor";

// ---------------------------------------------------------------------------
// AppsStore — descriptor + snapshot pointer persistence for the apps plugin,
// over the host-owned `pluginStorage` (collections) + `blobs` (content-addressed
// bundles / skill bodies). Executor plugins do not contribute DB tables, so the
// versioned descriptor is a JSON document in a plugin-storage collection keyed
// by scope, and the compiled bundles + skill bodies are blobs.
//
// One published descriptor per scope (the current published pointer). History
// is the ArtifactStore's git log; the runtime only runs the published snapshot.
// ---------------------------------------------------------------------------

/** The published descriptor document, keyed by scope. */
export const descriptorCollection = definePluginStorageCollection("published_descriptor", {
  Type: {} as {
    readonly scope: string;
    readonly snapshotId: string;
    readonly descriptor: AppDescriptor;
    readonly publishedAt: number;
  },
});

/** The explicit connection-name -> scope mapping (Fix 9), keyed by the
 *  (normalized) connection name. */
export const scopeConnectionCollection = definePluginStorageCollection("apps_scope_connection", {
  Type: {} as {
    readonly connectionName: string;
    readonly scope: string;
  },
});

export interface AppsStore {
  /** Persist the published descriptor for a scope (the published pointer). */
  readonly putDescriptor: (
    owner: "org" | "user",
    descriptor: AppDescriptor,
  ) => Effect.Effect<void, StorageFailure>;
  /** Read the current published descriptor for a scope, or null. */
  readonly getDescriptor: (scope: string) => Effect.Effect<AppDescriptor | null, StorageFailure>;
  /** Store a compiled bundle / skill body blob (content-addressed). */
  readonly putBlob: (key: string, value: string) => Effect.Effect<void, StorageFailure>;
  /** Read a blob by key. */
  readonly getBlob: (key: string) => Effect.Effect<string | null, StorageFailure>;
  /**
   * Record the explicit connection-name -> scope mapping (Fix 9). The executor
   * normalizes connection names to identifiers, so distinct scopes ("my-scope"
   * vs "my_scope") can normalize to the SAME name if we tried to parse the scope
   * back out. Storing the mapping at connect time makes the lookup exact and
   * collision-free; `resolveTools`/`invokeTool` consult it instead of reversing
   * the name. Idempotent (upsert).
   */
  readonly putScopeForConnection: (
    connectionName: string,
    scope: string,
  ) => Effect.Effect<void, StorageFailure>;
  /** The scope a connection name maps to, or null if none was recorded. */
  readonly getScopeForConnection: (
    connectionName: string,
  ) => Effect.Effect<string | null, StorageFailure>;
}

export interface AppsStoreDeps {
  readonly pluginStorage: PluginStorageFacade;
  readonly blobs: {
    readonly get: (key: string) => Effect.Effect<string | null, StorageFailure>;
    readonly put: (
      key: string,
      value: string,
      options: { readonly owner: "org" | "user" },
    ) => Effect.Effect<void, StorageFailure>;
  };
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
    putBlob: (key, value) => deps.blobs.put(key, value, { owner: "org" }),
    getBlob: (key) => deps.blobs.get(key),
  };
};
