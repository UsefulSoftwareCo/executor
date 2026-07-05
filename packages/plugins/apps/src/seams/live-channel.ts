import type { Effect } from "effect";
import { Data } from "effect";

// ---------------------------------------------------------------------------
// LiveChannel — invalidation-only pub/sub for live UI data.
//
// The protocol is invalidation, never rows: a scope-db write bumps a table's
// version counter and publishes `{scope, table, version}`; a subscribed widget
// refetches through its authed query path. No row data ever crosses the channel
// (MCP Apps forbids server push through the host, so live data rides this side
// channel; but even here we only ship invalidations). The self-hosted backing
// is an in-process emitter exposed as SSE on the Bun server; the cloud backing
// (future) is the DO/facet socket owner.
// ---------------------------------------------------------------------------

export class LiveChannelError extends Data.TaggedError("LiveChannelError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface Invalidation {
  readonly scope: string;
  readonly table: string;
  readonly version: number;
}

export interface LiveChannel {
  /** Publish an invalidation to every subscriber of the scope. */
  readonly publish: (event: Invalidation) => Effect.Effect<void, LiveChannelError>;
  /**
   * Subscribe to a scope's invalidations. The listener fires for each publish;
   * the returned thunk unsubscribes. Delivery is best-effort and unordered
   * beyond per-table version monotonicity.
   */
  readonly subscribe: (scope: string, listener: (event: Invalidation) => void) => () => void;
}
