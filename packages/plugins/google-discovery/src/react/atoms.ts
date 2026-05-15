import type { ScopeId } from "@executor-js/sdk/shared";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { sourcesOptimisticAtom } from "@executor-js/react/api/atoms";
import { ReactivityKey } from "@executor-js/react/api/reactivity-keys";
import { GoogleDiscoveryClient } from "./client";

// ---------------------------------------------------------------------------
// Query atoms
// ---------------------------------------------------------------------------

export const googleDiscoverySourceAtom = (scopeId: ScopeId, namespace: string) =>
  GoogleDiscoveryClient.query("googleDiscovery", "getSource", {
    params: { scopeId, namespace },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.sources, ReactivityKey.tools],
  });

// ---------------------------------------------------------------------------
// Mutation atoms
// ---------------------------------------------------------------------------

export const probeGoogleDiscovery = GoogleDiscoveryClient.mutation(
  "googleDiscovery",
  "probeDiscovery",
);
export const addGoogleDiscoverySource = GoogleDiscoveryClient.mutation(
  "googleDiscovery",
  "addSource",
);
export const addGoogleDiscoverySourceOptimistic = Atom.family((scopeId: ScopeId) =>
  sourcesOptimisticAtom(scopeId).pipe(
    Atom.optimisticFn({
      reducer: (current, arg) =>
        AsyncResult.map(current, (rows) => {
          const id = arg.payload.namespace ?? `pending-${Math.random().toString(36).slice(2)}`;
          const source = {
            id,
            scopeId,
            kind: "googleDiscovery",
            pluginId: "google-discovery",
            name: arg.payload.name,
            url: arg.payload.discoveryUrl,
            canRemove: false,
            canRefresh: false,
            canEdit: false,
            runtime: false,
          };
          return [source, ...rows.filter((row) => row.id !== id)].sort((a, b) =>
            a.name.localeCompare(b.name),
          );
        }),
      fn: addGoogleDiscoverySource,
    }),
  ),
);
export const updateGoogleDiscoverySource = GoogleDiscoveryClient.mutation(
  "googleDiscovery",
  "updateSource",
);
// OAuth flow atoms live on `@executor-js/react/api/atoms` now —
// `startOAuth`, `completeOAuth`, `probeOAuth`, `cancelOAuth` — one
// pair serves every OAuth-capable plugin.
