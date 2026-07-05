import type { Effect } from "effect";
import { Data } from "effect";

// ---------------------------------------------------------------------------
// ScopeDb — the per-scope app database (the shared primitive).
//
// One SQL database per scope: tools write it, workflows schedule tools, UI
// reads it, skills route the agent to it. The self-hosted backing is one libSQL
// (SQLite) file per scope; the cloud backing (future) is a Durable Object
// facet. The seam carries a template-tag `sql` (the author-facing shape) plus
// per-table version counters: every write bumps the touched table's version so
// the LiveChannel can publish an invalidation and widgets refetch.
//
// Scope isolation is structural: `forScope(a)` and `forScope(b)` are distinct
// databases; there is no cross-scope query path.
// ---------------------------------------------------------------------------

export class ScopeDbError extends Data.TaggedError("ScopeDbError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The author-facing db handle (matches `executor:app`'s `ScopeDb`): a tagged
 *  template returning rows. Also exposes the tables a statement touched so the
 *  runtime can bump version counters and publish invalidations. */
export interface ScopeDbHandle {
  readonly sql: <Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Effect.Effect<readonly Row[], ScopeDbError>;
  /** Run a raw statement (used by the runtime for probes/migrations). */
  readonly exec: <Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ) => Effect.Effect<readonly Row[], ScopeDbError>;
  /** Current version counter for a table (0 if never written). */
  readonly tableVersion: (table: string) => Effect.Effect<number, ScopeDbError>;
  /** Snapshot of every tracked table's version. */
  readonly versions: () => Effect.Effect<ReadonlyMap<string, number>, ScopeDbError>;
}

/** A write that touched tables, with the versions after the bump. Emitted so
 *  the runtime can drive `LiveChannel.publish`. */
export interface ScopeWriteEvent {
  readonly scope: string;
  readonly tables: readonly { readonly table: string; readonly version: number }[];
}

export interface ScopeDb {
  readonly forScope: (scope: string) => Effect.Effect<ScopeDbHandle, ScopeDbError>;
  /**
   * Subscribe to writes across scopes (the runtime wires this into LiveChannel).
   * Returns an unsubscribe thunk. Best-effort in-process; the cloud backing
   * makes the storage owner the notifier.
   */
  readonly onWrite: (listener: (event: ScopeWriteEvent) => void) => () => void;
  readonly close: () => Effect.Effect<void, ScopeDbError>;
}
