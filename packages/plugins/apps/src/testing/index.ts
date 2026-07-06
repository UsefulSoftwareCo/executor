import { Effect } from "effect";

import type { AppDescriptor } from "../pipeline/descriptor";
import type { AppsStore } from "../plugin/store";
import type { BindingError, ClientResolver, ConnectionCandidate } from "../plugin/bindings";
import {
  ArtifactStoreError,
  asSnapshotId,
  type ArtifactStore,
  type FileSet,
  type ScopeArtifactStore,
  type SnapshotId,
} from "../seams/artifact-store";
import { scopeAddressStorageKey } from "../seams/scope-address";

export * from "./daily-brief";

export const makeInMemoryAppsStore = (): AppsStore & {
  readonly descriptors: Map<string, AppDescriptor>;
} => {
  const descriptors = new Map<string, AppDescriptor>();
  const scopeConnections = new Map<string, string>();
  const keyFor = (tenant: string, key: string): string => `${tenant}:${key}`;
  return {
    descriptors,
    putDescriptor: (tenant, _owner, descriptor) =>
      Effect.sync(() => void descriptors.set(keyFor(tenant, descriptor.scope), descriptor)),
    getDescriptor: (tenant, scope) =>
      Effect.sync(() => descriptors.get(keyFor(tenant, scope)) ?? null),
    putScopeForConnection: (tenant, connectionName, scope) =>
      Effect.sync(() => void scopeConnections.set(keyFor(tenant, connectionName), scope)),
    getScopeForConnection: (tenant, connectionName) =>
      Effect.sync(() => scopeConnections.get(keyFor(tenant, connectionName)) ?? null),
  };
};

export const makeInMemoryArtifactStore = (): ArtifactStore => {
  const scopes = new Map<string, Map<string, FileSet>>();
  const order = new Map<string, string[]>();
  let counter = 0;
  const forScope = (key: string): ScopeArtifactStore => {
    const snaps = scopes.get(key) ?? new Map<string, FileSet>();
    scopes.set(key, snaps);
    const seq = order.get(key) ?? [];
    order.set(key, seq);
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
  return { forScope: (address) => Effect.succeed(forScope(scopeAddressStorageKey(address))) };
};

export type { SnapshotId };

export const makeTestResolver = (
  handlers: Record<string, Record<string, (args: readonly unknown[]) => unknown>>,
  connections?: readonly ConnectionCandidate[],
): ClientResolver & {
  readonly calls: { integration: string; connection: string; method: string }[];
} => {
  const calls: { integration: string; connection: string; method: string }[] = [];
  const knownConnections =
    connections ??
    Object.keys(handlers).map((integration) => ({
      address: `tools.${integration}.user.${integration}`,
      integration,
      name: integration,
      owner: "user",
    }));
  return {
    calls,
    listConnections: ({ integration }) =>
      Effect.succeed(
        knownConnections.filter((connection) => connection.integration === integration),
      ),
    resolveConnection: ({ connection }) =>
      Effect.succeed(
        knownConnections.find(
          (candidate) => candidate.address === connection || candidate.name === connection,
        ) ?? null,
      ),
    call: ({ integration, connection, path, args }) => {
      const method = path.join(".");
      calls.push({ integration, connection, method });
      const handler = handlers[integration]?.[method];
      if (!handler) {
        return Effect.fail({
          _tag: "BindingError",
          message: `no test handler for ${integration}.${method}`,
          role: integration,
          integration,
        } as unknown as BindingError);
      }
      return Effect.sync(() => handler(args));
    },
  };
};
