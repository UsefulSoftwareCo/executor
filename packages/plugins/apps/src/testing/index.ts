import { Effect } from "effect";

import type { AppDescriptor } from "../pipeline/descriptor";
import type { AppsStore } from "../plugin/store";
import type { ClientResolver, BindingError } from "../plugin/bindings";
import {
  ArtifactStoreError,
  asSnapshotId,
  type ArtifactStore,
  type FileSet,
  type ScopeArtifactStore,
  type SnapshotId,
} from "../seams/artifact-store";

// ---------------------------------------------------------------------------
// Test helpers: an in-memory AppsStore and a canned ClientResolver, plus the
// daily-brief fixture set. Used by the runtime integration test and the e2e.
// ---------------------------------------------------------------------------

export * from "./daily-brief";

/** In-memory AppsStore (descriptors + blobs in Maps). */
export const makeInMemoryAppsStore = (): AppsStore & {
  readonly blobs: Map<string, string>;
  readonly descriptors: Map<string, AppDescriptor>;
} => {
  const descriptors = new Map<string, AppDescriptor>();
  const blobs = new Map<string, string>();
  const scopeConnections = new Map<string, string>();
  return {
    descriptors,
    blobs,
    putDescriptor: (_owner, descriptor) =>
      Effect.sync(() => void descriptors.set(descriptor.scope, descriptor)),
    getDescriptor: (scope) => Effect.sync(() => descriptors.get(scope) ?? null),
    putBlob: (key, value) => Effect.sync(() => void blobs.set(key, value)),
    getBlob: (key) => Effect.sync(() => blobs.get(key) ?? null),
    putScopeForConnection: (connectionName, scope) =>
      Effect.sync(() => void scopeConnections.set(connectionName, scope)),
    getScopeForConnection: (connectionName) =>
      Effect.sync(() => scopeConnections.get(connectionName) ?? null),
  };
};

/** An in-memory ArtifactStore for conformance/unit tests: content-addressed by
 *  a monotonic counter (a stand-in commit hash). Immutable once committed, which
 *  is all the WorkflowDriver / bundle-loader path needs. */
export const makeInMemoryArtifactStore = (): ArtifactStore => {
  const scopes = new Map<string, Map<string, FileSet>>();
  const order = new Map<string, string[]>();
  let counter = 0;
  const forScope = (scope: string): ScopeArtifactStore => {
    const snaps = scopes.get(scope) ?? new Map<string, FileSet>();
    scopes.set(scope, snaps);
    const seq = order.get(scope) ?? [];
    order.set(scope, seq);
    return {
      commit: (files, message) =>
        Effect.sync(() => {
          const id = `mem${(++counter).toString(16).padStart(40, "0")}`;
          snaps.set(id, new Map(files));
          seq.push(id);
          return { id: asSnapshotId(id), message, committedAt: Date.now() };
        }),
      read: (id) =>
        snaps.has(id)
          ? Effect.succeed(snaps.get(id)!)
          : Effect.fail(new ArtifactStoreError({ message: `no snapshot ${id}` })),
      readFile: (id, path) => Effect.succeed(snaps.get(id)?.get(path) ?? null),
      list: (id) => Effect.succeed([...(snaps.get(id)?.keys() ?? [])]),
      latest: () =>
        Effect.sync(() => {
          const last = seq.at(-1);
          if (!last) return null;
          return { id: asSnapshotId(last), message: "latest", committedAt: Date.now() };
        }),
      log: (limit) =>
        Effect.sync(() =>
          [...seq]
            .reverse()
            .slice(0, limit ?? seq.length)
            .map((id) => ({ id: asSnapshotId(id), message: "", committedAt: Date.now() })),
        ),
    };
  };
  return { forScope: (scope) => Effect.succeed(forScope(scope)) };
};

export type { SnapshotId };

/** A resolver that dispatches integration method calls to supplied handlers.
 *  `handlers[integration][path.join(".")]` returns the JSON result. */
export const makeTestResolver = (
  handlers: Record<string, Record<string, (args: readonly unknown[]) => unknown>>,
): ClientResolver & {
  readonly calls: { integration: string; connection: string; method: string }[];
} => {
  const calls: { integration: string; connection: string; method: string }[] = [];
  return {
    calls,
    call: ({ integration, connection, path, args }) => {
      const method = path.join(".");
      calls.push({ integration, connection, method });
      const handler = handlers[integration]?.[method];
      if (!handler) {
        return Effect.fail({
          _tag: "BindingError",
          message: `no test handler for ${integration}.${method}`,
          role: integration,
          surface: integration,
        } as unknown as BindingError);
      }
      return Effect.sync(() => handler(args));
    },
  };
};
