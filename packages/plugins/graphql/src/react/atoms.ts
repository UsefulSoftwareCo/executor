import type { ScopeId } from "@executor-js/sdk/core";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { sourcesOptimisticAtom } from "@executor-js/react/api/atoms";
import { ReactivityKey } from "@executor-js/react/api/reactivity-keys";
import { GraphqlClient } from "./client";

// ---------------------------------------------------------------------------
// Query atoms
// ---------------------------------------------------------------------------

export const graphqlSourceAtom = (scopeId: ScopeId, namespace: string) =>
  GraphqlClient.query("graphql", "getSource", {
    params: { scopeId, namespace },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.sources, ReactivityKey.tools],
  });

export const graphqlSourceBindingsAtom = (
  scopeId: ScopeId,
  namespace: string,
  sourceScopeId: ScopeId,
) =>
  GraphqlClient.query("graphql", "listSourceBindings", {
    params: { scopeId, namespace, sourceScopeId },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.sources, ReactivityKey.secrets, ReactivityKey.connections],
  });

// ---------------------------------------------------------------------------
// Mutation atoms
// ---------------------------------------------------------------------------

export const addGraphqlSource = GraphqlClient.mutation("graphql", "addSource");

export const addGraphqlSourceOptimistic = Atom.family((scopeId: ScopeId) =>
  sourcesOptimisticAtom(scopeId).pipe(
    Atom.optimisticFn({
      reducer: (current, arg) =>
        AsyncResult.map(current, (rows) => {
          const id = arg.payload.namespace ?? `pending-${Math.random().toString(36).slice(2)}`;
          const source = {
            id,
            scopeId: arg.payload.targetScope,
            kind: "graphql",
            pluginId: "graphql",
            name: arg.payload.name ?? id,
            url: arg.payload.endpoint,
            canRemove: false,
            canRefresh: false,
            canEdit: false,
            runtime: false,
          };
          return [source, ...rows.filter((row) => row.id !== id)].sort((a, b) =>
            a.name.localeCompare(b.name),
          );
        }),
      fn: addGraphqlSource,
    }),
  ),
);

export const updateGraphqlSource = GraphqlClient.mutation("graphql", "updateSource");

export const setGraphqlSourceBinding = GraphqlClient.mutation("graphql", "setSourceBinding");

export const removeGraphqlSourceBinding = GraphqlClient.mutation("graphql", "removeSourceBinding");
