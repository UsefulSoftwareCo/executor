// ---------------------------------------------------------------------------
// Tool-catalog sync lifecycle — the pure state model behind every decision the
// executor makes about re-listing a connection's tools.
//
// No storage, no clock, no randomness: the connection's columns arrive as a
// value, `now` and the backoff jitter arrive as arguments, and every function
// here is total. That is what makes the ladder, the cap and the eligibility
// rules testable directly rather than through a database and a live upstream,
// and it is what will let PR 3's background scheduler reuse the same rules
// without reimplementing them against a different clock.
// ---------------------------------------------------------------------------

/** Why a catalog listing could not be completed, as a CLOSED set persisted on
 *  `connection.tools_sync_error_kind`.
 *
 *  Structural on purpose: the previous mechanism was a `"Tool sync failing: "`
 *  prefix on the human-readable health detail, which meant every consumer that
 *  wanted to know "is this connection's catalog broken, and how" had to match a
 *  display string. These four values are the whole vocabulary:
 *
 *  - `auth`     the credential is rejected or absent. Retrying the same grant
 *               cannot change the verdict, so it PARKS the connection (see
 *               {@link isToolSyncParked}) until a human re-authorizes.
 *  - `unreachable` the upstream did not answer (DNS, connect, timeout).
 *  - `protocol` the upstream answered but the listing could not be read.
 *  - `config`   the integration's own configuration cannot produce a listing
 *               (unparseable spec, disabled transport, missing endpoint). */
export type ToolSyncErrorKind = "auth" | "unreachable" | "protocol" | "config";

export const TOOL_SYNC_ERROR_KINDS = [
  "auth",
  "unreachable",
  "protocol",
  "config",
] as const satisfies readonly ToolSyncErrorKind[];

/** Narrow a persisted `tools_sync_error_kind` column back to the closed set.
 *  The column is plain text, so a value written by a newer build (or edited by
 *  hand) has to be parsed rather than trusted. */
export const isToolSyncErrorKind = (value: unknown): value is ToolSyncErrorKind =>
  typeof value === "string" && (TOOL_SYNC_ERROR_KINDS as readonly string[]).includes(value);

/**
 * What a connection's persisted catalog is, relative to now.
 *
 * Every non-`fresh` value is exactly the reason a read has to re-list, so this
 * doubles as the refresh trigger reported on the `executor.tools.sync` span.
 *
 * `cold` and `stale_marked` were one value before the `tools_stale_at` column
 * existed: `connections.markToolsStale` cleared `tools_synced_at`, which made a
 * connection that had never synced indistinguishable from one whose catalog was
 * invalidated mid-invocation, and destroyed the last-verified timestamp in the
 * process.
 */
export type ToolSyncState = "fresh" | "cold" | "stale_marked" | "config_revised" | "expired";

/** Why an otherwise-due connection is not being refreshed right now. Enumerable
 *  so the read's span can count each reason. */
export type ToolSyncSkip = "fresh" | "parked" | "backoff" | "claimed";

/**
 * A connection's sync lifecycle columns, plus the two facts that live on its
 * integration and plugin (`config_revised_at`, whether the plugin lists a live
 * remote catalog) and the executor's freshness window.
 *
 * Decoded from the row by the caller: bigint columns arrive as `bigint | null`
 * from the driver, and the text `tools_sync_error_kind` has to pass
 * {@link isToolSyncErrorKind} before it gets here.
 */
export interface ToolSyncCandidate {
  /** Epoch ms of the last AUTHORITATIVE listing. Never stamped by a failed or
   *  incomplete one — a month-dead server must not read as "synced 30s ago". */
  readonly toolsSyncedAt: number | null;
  /** Epoch ms an event declared the persisted catalog drifted. */
  readonly toolsStaleAt: number | null;
  /** The nonce of the refresh attempt currently holding the write lease. */
  readonly toolsSyncClaimId: string | null;
  /** Epoch ms the claim was taken, against which the lease expires. */
  readonly toolsSyncClaimAt: number | null;
  /** CONSECUTIVE failed listings; zeroed by an authoritative one. */
  readonly toolsSyncFailures: number;
  /** Epoch ms of the earliest next attempt. */
  readonly toolsSyncRetryAt: number | null;
  readonly toolsSyncErrorKind: ToolSyncErrorKind | null;
  /** The integration's `config_revised_at`: its last tool-affecting config
   *  change. */
  readonly configRevisedAt: number | null;
  /** The plugin lists a live remote catalog (an MCP server, whose tool set can
   *  change with no executor-visible signal), so time alone can expire it. */
  readonly remoteToolCatalog: boolean;
  /** The freshness window; `null` disables time-based expiry entirely. */
  readonly ttlMs: number | null;
}

/**
 * How long a refresh claim stays valid.
 *
 * A lease rather than a lock: the claimant can be a Workers isolate that is
 * evicted mid-handshake, and nothing would ever release its claim. Long enough
 * to cover a slow upstream listing (discovery is bounded well under this),
 * short enough that a lost claimant costs one wasted freshness window.
 */
export const TOOL_SYNC_CLAIM_LEASE_MS = 60_000;

/** The longest a failing connection is left alone. Past this the ladder stops
 *  doubling: a server that has been dead for a week still gets probed a few
 *  times a day, which is what makes recovery automatic. */
export const TOOL_SYNC_BACKOFF_CEILING_MS = 6 * 60 * 60 * 1000;

/** Bounds of the multiplicative jitter applied to every backoff delay, so a
 *  fleet that lost the same upstream at the same moment does not re-dial it in
 *  lockstep. The factor itself is supplied by the caller — this module owns no
 *  randomness. */
export const TOOL_SYNC_JITTER_MIN = 0.8;
export const TOOL_SYNC_JITTER_MAX = 1.2;

/**
 * Classify a connection's catalog. Total, and ordered by authority: an explicit
 * drift signal outranks a config revision, which outranks the clock.
 *
 * The stale comparison is `>=`, not `>`: `Date.now()` has millisecond
 * granularity, and a `tools/list_changed` notification arriving in the same
 * millisecond as the stamp it invalidates must not be swallowed.
 */
export const classifyToolSync = (candidate: ToolSyncCandidate, now: number): ToolSyncState => {
  const syncedAt = candidate.toolsSyncedAt;
  // A never-synced connection sorts before every stamp, which is why the
  // comparisons below read through `?? 0` rather than special-casing null.
  if (candidate.toolsStaleAt !== null && candidate.toolsStaleAt >= (syncedAt ?? 0)) {
    return "stale_marked";
  }
  if (syncedAt === null) return "cold";
  if (candidate.configRevisedAt !== null && syncedAt < candidate.configRevisedAt) {
    return "config_revised";
  }
  if (candidate.remoteToolCatalog && candidate.ttlMs !== null && syncedAt < now - candidate.ttlMs) {
    return "expired";
  }
  return "fresh";
};

/** Whether another attempt currently holds the write lease. A claim with no
 *  `claim_at` is treated as dead rather than eternal, so a half-written row can
 *  never wedge a connection out of every future refresh. */
export const isToolSyncClaimLive = (candidate: ToolSyncCandidate, now: number): boolean =>
  candidate.toolsSyncClaimId !== null &&
  candidate.toolsSyncClaimAt !== null &&
  now - candidate.toolsSyncClaimAt < TOOL_SYNC_CLAIM_LEASE_MS;

/**
 * Whether the failure ladder is still holding this connection off.
 *
 * Gated on `failures > 0` deliberately. `tools_sync_retry_at` is also written
 * after a SUCCESS, where it records the TTL horizon so a scheduler can order
 * work by one column; treating that as a gate would make a `list_changed`
 * notification wait out the freshness window before it could heal the catalog.
 * An event-driven drift re-lists immediately; only a failing one waits.
 */
export const isToolSyncBackedOff = (candidate: ToolSyncCandidate, now: number): boolean =>
  candidate.toolsSyncFailures > 0 &&
  candidate.toolsSyncRetryAt !== null &&
  now < candidate.toolsSyncRetryAt;

/** Whether the connection is parked: its credential is rejected, and no amount
 *  of retrying the same grant will change that. Cleared by the human-initiated
 *  paths that can actually fix it (explicit refresh, connection update, an
 *  OAuth re-mint, a healthy probe, a fresh drift signal). */
export const isToolSyncParked = (candidate: ToolSyncCandidate): boolean =>
  candidate.toolsSyncErrorKind === "auth";

/**
 * Refresh this connection, or pass it over and say why. ONE decision rather
 * than a predicate plus a re-classification, so a caller that needs both the
 * verdict and the trigger cannot end up asking two questions with two answers.
 *
 * Every clause that can stop a refresh lives here, and that is the point: a
 * read's inline refresh, an explicit signal and a background sweep all consult
 * this, so "when do we dial an upstream" has one answer rather than one per
 * caller. A `connection.status` lifecycle (disabled, revoked) belongs here too
 * when it lands, as one more skip clause — putting it at a call site is what
 * would reintroduce the divergence this exists to prevent.
 *
 * Ordered cheapest-and-most-final first, so the reason an operator sees on the
 * span is the one they would name. A live claim observed on the row is only a
 * pre-filter: the binding decision is the compare-and-set the caller runs
 * against the database, and two readers that both see a free claim here still
 * resolve to one refresh.
 */
export type ToolSyncDecision =
  | { readonly kind: "skip"; readonly reason: ToolSyncSkip }
  | { readonly kind: "refresh"; readonly trigger: Exclude<ToolSyncState, "fresh"> };

export const decideToolSync = (candidate: ToolSyncCandidate, now: number): ToolSyncDecision => {
  const state = classifyToolSync(candidate, now);
  if (state === "fresh") return { kind: "skip", reason: "fresh" };
  if (isToolSyncParked(candidate)) return { kind: "skip", reason: "parked" };
  if (isToolSyncBackedOff(candidate, now)) return { kind: "skip", reason: "backoff" };
  if (isToolSyncClaimLive(candidate, now)) return { kind: "skip", reason: "claimed" };
  return { kind: "refresh", trigger: state };
};

/** THE eligibility predicate, for callers that only need the yes/no. */
export const isSyncEligible = (candidate: ToolSyncCandidate, now: number): boolean =>
  decideToolSync(candidate, now).kind === "refresh";

/** The earliest next attempt after an AUTHORITATIVE listing: one freshness
 *  window out, or `null` when time-based re-sync is disabled. Not a gate (see
 *  {@link isToolSyncBackedOff}) — it is the horizon a scheduler sorts by. */
export const scheduleAfterSuccess = (now: number, ttlMs: number | null): number | null =>
  ttlMs === null ? null : now + ttlMs;

/**
 * The earliest next attempt after a FAILED listing: `ttlMs × 2^(failures−1)`,
 * capped at {@link TOOL_SYNC_BACKOFF_CEILING_MS}, scaled by `jitter`.
 *
 * `failures` is the count INCLUDING the failure being recorded, so the first
 * failure waits one plain TTL; values below 1 are read as 1 rather than halving
 * the first delay. `jitter` belongs to the caller and is expected in
 * [{@link TOOL_SYNC_JITTER_MIN}, {@link TOOL_SYNC_JITTER_MAX}]; it is not
 * clamped here, because a call site that passes something else has a bug worth
 * seeing rather than silently correcting.
 *
 * Rounded: the result lands in a bigint column.
 */
export const scheduleAfterFailure = (
  now: number,
  ttlMs: number,
  failures: number,
  jitter: number,
): number =>
  Math.round(
    now + Math.min(TOOL_SYNC_BACKOFF_CEILING_MS, ttlMs * 2 ** (Math.max(1, failures) - 1)) * jitter,
  );
