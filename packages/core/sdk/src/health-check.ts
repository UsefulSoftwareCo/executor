// ---------------------------------------------------------------------------
// @executor-js/sdk health-check vocabulary — browser-safe.
//
// A health check is a single declared, authenticated operation a connection can
// run to answer one question: "is this credential still alive?". The plugin owns
// WHICH operation (it lives in the plugin's opaque integration config, picked by
// the user the same way auth methods are configured); core owns the shared
// vocabulary below so every surface (API, React, plugins) speaks the same shapes.
//
// The probe runs an operation with optional pinned `args` (some liveness
// endpoints need a fixed parameter; e.g. Google's People API needs
// `resourceName=people/me`), maps the HTTP status to a `HealthStatus`, and
// reports it. Everything here is pure Effect/Schema with no server/node imports
// so it is safe to import from React.
// ---------------------------------------------------------------------------

import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Status — the four states a connection can be in. `expired` is the one this
// whole feature exists for (Google's 7-day dev-token revocation): the credential
// authenticated fine yesterday and now returns 401/403. `degraded` covers any
// other non-2xx (upstream 5xx, a 404 on a mis-picked operation); `unknown` is
// "never checked / no health check configured".
// ---------------------------------------------------------------------------

export const HealthStatus = Schema.Literals(["healthy", "expired", "degraded", "unknown"]);
export type HealthStatus = typeof HealthStatus.Type;

// ---------------------------------------------------------------------------
// HealthCheckSpec — the persisted configuration: which operation to run and any
// pinned arguments. Stored inside the owning plugin's opaque integration config;
// core never parses it (the plugin reads it back in `checkHealth`).
// ---------------------------------------------------------------------------

export const HealthCheckSpec = Schema.Struct({
  /** The tool / operation name to invoke (the plugin maps this to its binding). */
  operation: Schema.String,
  /** Pinned arguments merged into the probe call. Required for liveness
   *  endpoints that take a fixed parameter (e.g. People API `resourceName`). */
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type HealthCheckSpec = typeof HealthCheckSpec.Type;

// ---------------------------------------------------------------------------
// HealthCheckResult — the outcome of running a probe. `httpStatus` and `detail`
// are diagnostic.
// ---------------------------------------------------------------------------

export const HealthCheckResult = Schema.Struct({
  status: HealthStatus,
  /** The HTTP status the probe observed, when the check ran against HTTP. */
  httpStatus: Schema.optional(Schema.Number),
  /** Epoch ms the check ran. */
  checkedAt: Schema.Number,
  /** Human-readable diagnostic (error message, "no health check configured"). */
  detail: Schema.optional(Schema.String),
});
export type HealthCheckResult = typeof HealthCheckResult.Type;

// ---------------------------------------------------------------------------
// HealthCheckCandidate — one operation the user can pick as the health check,
// projected from the plugin's stored operations. The editor lists these ranked
// (non-destructive first, then fewest required args) so the obvious "GET /me"
// style endpoint floats to the top.
// ---------------------------------------------------------------------------

export const HealthCheckCandidateParameter = Schema.Struct({
  name: Schema.String,
  /** Where the parameter is carried (e.g. "query", "path", "header"). */
  location: Schema.String,
  required: Schema.Boolean,
  description: Schema.optional(Schema.String),
});
export type HealthCheckCandidateParameter = typeof HealthCheckCandidateParameter.Type;

export const HealthCheckCandidate = Schema.Struct({
  /** The operation / tool name to store as `HealthCheckSpec.operation`. */
  operation: Schema.String,
  /** HTTP method, lower-cased ("get", "post", …), for display + ranking. */
  method: Schema.String,
  /** How many parameters are required to call it (ranking key: fewer is better). */
  requiredArgCount: Schema.Number,
  /** True for mutating methods (post/put/patch/delete) — ranked last and shown
   *  with a warning, since a health check should be safe to run repeatedly. */
  destructive: Schema.Boolean,
  /** Operation summary / description for display, when known. */
  summary: Schema.optional(Schema.String),
  /** The operation's parameters, so the editor can offer pinned-arg inputs. */
  parameters: Schema.optional(Schema.Array(HealthCheckCandidateParameter)),
});
export type HealthCheckCandidate = typeof HealthCheckCandidate.Type;

// ---------------------------------------------------------------------------
// Pure helpers — shared so classification behaves identically wherever a probe
// is interpreted.
// ---------------------------------------------------------------------------

/** Map an HTTP status to a health state: 2xx healthy, 401/403 expired (the auth
 *  wall), everything else degraded. */
export const classifyHttpStatus = (status: number): HealthStatus => {
  if (status >= 200 && status < 300) return "healthy";
  if (status === 401 || status === 403) return "expired";
  return "degraded";
};

/** Stable ranking for the candidate list: non-destructive before destructive,
 *  then fewest required args, then by method (get first), then alphabetical.
 *  Returns a negative/zero/positive comparator value. */
export const compareHealthCheckCandidates = (
  a: HealthCheckCandidate,
  b: HealthCheckCandidate,
): number => {
  if (a.destructive !== b.destructive) return a.destructive ? 1 : -1;
  if (a.requiredArgCount !== b.requiredArgCount) return a.requiredArgCount - b.requiredArgCount;
  if (a.method !== b.method) {
    if (a.method === "get") return -1;
    if (b.method === "get") return 1;
    return a.method < b.method ? -1 : 1;
  }
  return a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0;
};
