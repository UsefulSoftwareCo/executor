import type { Effect } from "effect";
import { Data } from "effect";

// ---------------------------------------------------------------------------
// ScopeDb — the per-scope app database (the shared primitive).
//
// One SQL database per scope: tools read and write it. The self-hosted backing
// is one libSQL (SQLite) file per scope; the cloud backing (future) is a
// Durable Object facet. The seam carries a template-tag `sql` (the author-facing
// shape) plus per-table version counters.
//
// Scope isolation is structural: `forScope(a)` and `forScope(b)` are distinct
// databases; there is no cross-scope query path.
// ---------------------------------------------------------------------------

export class ScopeDbError extends Data.TaggedError("ScopeDbError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The author-facing db handle (matches `executor:app`'s `ScopeDb`): a tagged
 *  template returning rows. */
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

export interface ScopeDb {
  readonly forScope: (scope: string) => Effect.Effect<ScopeDbHandle, ScopeDbError>;
  readonly close: () => Effect.Effect<void, ScopeDbError>;
}
