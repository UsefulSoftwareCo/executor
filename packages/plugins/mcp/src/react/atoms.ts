import type { ScopeId } from "@executor-js/sdk/core";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { sourcesOptimisticAtom } from "@executor-js/react/api/atoms";
import { ReactivityKey } from "@executor-js/react/api/reactivity-keys";
import { McpClient } from "./client";

// ---------------------------------------------------------------------------
// Query atoms
// ---------------------------------------------------------------------------

export const mcpSourceAtom = (scopeId: ScopeId, namespace: string) =>
  McpClient.query("mcp", "getSource", {
    params: { scopeId, namespace },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.sources, ReactivityKey.tools],
  });

export const mcpSourceBindingsAtom = (
  scopeId: ScopeId,
  namespace: string,
  sourceScopeId: ScopeId,
) =>
  McpClient.query("mcp", "listSourceBindings", {
    params: { scopeId, namespace, sourceScopeId },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.sources, ReactivityKey.secrets, ReactivityKey.connections],
  });

// ---------------------------------------------------------------------------
// Mutation atoms
// ---------------------------------------------------------------------------

export const probeMcpEndpoint = McpClient.mutation("mcp", "probeEndpoint");
export const addMcpSource = McpClient.mutation("mcp", "addSource");
export const addMcpSourceOptimistic = Atom.family((scopeId: ScopeId) =>
  sourcesOptimisticAtom(scopeId).pipe(
    Atom.optimisticFn({
      reducer: (current, arg) =>
        AsyncResult.map(current, (rows) => {
          const id = arg.payload.namespace ?? `pending-${Math.random().toString(36).slice(2)}`;
          const source = {
            id,
            scopeId: arg.payload.targetScope,
            kind: "mcp",
            pluginId: "mcp",
            name: arg.payload.name ?? id,
            ...(arg.payload.transport === "remote" ? { url: arg.payload.endpoint } : {}),
            canRemove: false,
            canRefresh: false,
            canEdit: false,
            runtime: false,
          };
          return [source, ...rows.filter((row) => row.id !== id)].sort((a, b) =>
            a.name.localeCompare(b.name),
          );
        }),
      fn: addMcpSource,
    }),
  ),
);
export const removeMcpSource = McpClient.mutation("mcp", "removeSource");
export const refreshMcpSource = McpClient.mutation("mcp", "refreshSource");
export const updateMcpSource = McpClient.mutation("mcp", "updateSource");
export const setMcpSourceBinding = McpClient.mutation("mcp", "setSourceBinding");
export const removeMcpSourceBinding = McpClient.mutation("mcp", "removeSourceBinding");
