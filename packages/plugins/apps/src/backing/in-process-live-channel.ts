import { Effect } from "effect";

import type { Invalidation, LiveChannel } from "../seams/live-channel";

// ---------------------------------------------------------------------------
// In-process LiveChannel (self-hosted). A per-scope set of listeners; publish
// fans out synchronously. The self-host server exposes each subscription as an
// SSE stream. The cloud backing (future) makes the storage owner the notifier.
// ---------------------------------------------------------------------------

export const makeInProcessLiveChannel = (): LiveChannel => {
  const byScope = new Map<string, Set<(event: Invalidation) => void>>();

  return {
    publish: (event: Invalidation) =>
      Effect.sync(() => {
        const listeners = byScope.get(event.scope);
        if (!listeners) return;
        for (const listener of listeners) listener(event);
      }),
    subscribe: (scope: string, listener: (event: Invalidation) => void) => {
      let set = byScope.get(scope);
      if (!set) {
        set = new Set();
        byScope.set(scope, set);
      }
      set.add(listener);
      return () => {
        set?.delete(listener);
        if (set && set.size === 0) byScope.delete(scope);
      };
    },
  };
};
