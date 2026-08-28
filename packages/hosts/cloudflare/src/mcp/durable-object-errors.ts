/**
 * Classification of Cloudflare *platform* Durable Object failures.
 *
 * A Durable Object can be torn out from under its own code by the runtime, and
 * when that happens the only thing the caller receives is a plain `Error` whose
 * message is the entire signal. Those are not application defects: the object
 * was healthy, the request was valid, and the correct answer to the client is
 * "this id is dead, reconnect" or "come back in a moment" — never an unhandled
 * 500 and never an error report.
 *
 * The codebase already classifies transient-vs-definitive failures carefully
 * for the auth provider; this is the same discipline for the one other
 * dependency that fails without a typed error: the DO platform itself.
 *
 * Everything not listed here stays UNCLASSIFIED on purpose. An unrecognized
 * failure keeps its current behaviour — rethrow, report, page — because the
 * cost of silently swallowing a real defect is much higher than the cost of one
 * more retryable envelope.
 */
import { Cause } from "effect";

import { jsonRpcErrorBody, UNAVAILABLE_RETRY_AFTER_SECONDS } from "@executor-js/host-mcp";

/**
 * The specific platform condition, kept granular so it can be recorded on a
 * span (`mcp.do.reset_kind`) and the aggregate bucket split by cause in
 * production instead of being one opaque pile.
 */
export type DurableObjectFailureKind =
  /** The object called `ctx.abort("destroyed")` on itself — session teardown. */
  | "destroyed"
  /** A deploy replaced the script and the runtime reset every live object. */
  | "code_update"
  /** A storage op ran past the platform's ceiling; the object was reset. */
  | "storage_timeout"
  /** The storage backend failed internally and reset the object. */
  | "storage_internal"
  /** The storage backend failed internally *while bringing the object up*. */
  | "startup_internal_error"
  /** `blockConcurrencyWhile()` ran past its cap and was cancelled. */
  | "concurrency_reset"
  /** An invocation ran past the per-invocation CPU ceiling; the object was reset. */
  | "cpu_limit"
  /** A generic platform blip: `internal error; reference = <id>`. */
  | "internal_error"
  /** The runtime itself flagged the error as retryable. */
  | "retryable";

/**
 * What the caller should do about it.
 *
 * - `session_dead` — the object is gone for good; the id will never work again,
 *   so the client must mint a new session.
 * - `transient` — the object was reset but the id is still valid; the very next
 *   attempt is likely to succeed.
 */
export type DurableObjectFailureDisposition = "session_dead" | "transient";

export type DurableObjectFailure = {
  readonly kind: DurableObjectFailureKind;
  readonly disposition: DurableObjectFailureDisposition;
};

/**
 * Message fragments workerd puts on the plain `Error` it throws. Matched
 * case-insensitively on a substring because the runtime appends ids and
 * punctuation ("… reference = 0123abcd") and has reworded these before.
 */
const MESSAGE_PATTERNS: ReadonlyArray<{
  readonly fragment: string;
  readonly failure: DurableObjectFailure;
}> = [
  {
    fragment: "durable object reset because its code was updated",
    failure: { kind: "code_update", disposition: "transient" },
  },
  {
    fragment: "storage operation exceeded timeout",
    failure: { kind: "storage_timeout", disposition: "transient" },
  },
  {
    fragment: "internal error in durable object storage",
    failure: { kind: "storage_internal", disposition: "transient" },
  },
  {
    // The startup sibling of the entry above: the storage backend faults while
    // the object is being brought up rather than while it is serving, and the
    // runtime says so in a different clause ("… while starting up Durable
    // Object storage caused object to be reset; reference = <id>").
    //
    // Deliberately stops before "storage": the two known members of this family
    // agree on "Internal error … Durable Object" and disagree on everything
    // that follows the verb, so the qualifier is the part most likely to move
    // and is not what identifies the failure. Equally deliberately NOT
    // shortened to the shared tail "caused object to be reset" — that tail is
    // common to several unrelated storage faults and would stop this bucket
    // from meaning anything on a span.
    //
    // Transient for the same reason as its sibling: nothing about the request
    // caused it, the id still routes, and the object gets a fresh start on the
    // next attempt.
    fragment: "internal error while starting up durable object",
    failure: { kind: "startup_internal_error", disposition: "transient" },
  },
  {
    // Deliberately the whole phrase, not the bare method name: an application
    // defect thrown from inside a `blockConcurrencyWhile` callback also resets
    // the object, and a message that merely names the method must not be read
    // as a platform reset and quietly turned into a retry.
    fragment: "blockconcurrencywhile() in a durable object waited for too long",
    failure: { kind: "concurrency_reset", disposition: "transient" },
  },
  {
    // Deliberately starts at the verb, not at "Durable Object": the runtime's
    // resource-limit messages disagree about the subject noun (the memory
    // variant says "Durable Object's isolate exceeded its memory limit"), and
    // pinning a subject here would let a rewording defeat the match. From
    // "exceeded its CPU time limit" onward the phrase is the runtime's alone.
    //
    // Transient, not a defect: the invocation was cut off but the object's
    // durable storage is untouched and the session id still routes, so the next
    // attempt — a smaller unit of work, or the same one under a warm isolate —
    // can succeed. Retrying the same id is strictly better than the unhandled
    // 500 this produced before.
    fragment: "exceeded its cpu time limit and was reset",
    failure: { kind: "cpu_limit", disposition: "transient" },
  },
  {
    // Only the bare blip. A reference id at the end of the message is NOT the
    // marker: the runtime also appends one to described faults such as the
    // startup failure above, and because this fragment includes the semicolon
    // that immediately follows "internal error", any interposed description
    // defeats it. Those variants each need their own entry rather than a
    // loosened version of this one, which would turn every referenced error
    // into an opaque "internal_error" bucket.
    fragment: "internal error; reference =",
    failure: { kind: "internal_error", disposition: "transient" },
  },
  // Not listed, on purpose: the sibling memory-limit reset ("Durable Object's
  // isolate exceeded its memory limit due to overflowing the storage cache …
  // All objects in the isolate were reset."). The runtime tags that one as a
  // user error, and it names its own cause — too many un-awaited writes, or one
  // oversized read. Retrying reproduces it, so calling it transient would bury
  // an application defect behind a 503 instead of surfacing it.
];

/**
 * `ctx.abort("destroyed")` surfaces as an `Error` whose message is exactly the
 * abort reason, so this one is matched whole rather than as a substring — a
 * message that merely mentions the word must not condemn a live session.
 */
const DESTROYED_MESSAGE = "destroyed";

/** How deep to follow `error.cause` before giving up. */
const MAX_UNWRAP_DEPTH = 5;

const messageOf = (error: unknown): string | null => {
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return null;
  // oxlint-disable-next-line executor/no-unknown-error-message -- platform boundary: workerd rejects with an untyped Error whose message IS the only signal; reading it here is the entire purpose of this module, and it exists so no other file has to
  const message = (error as { readonly message?: unknown }).message;
  return typeof message === "string" ? message : null;
};

const isRuntimeRetryable = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { readonly retryable?: unknown }).retryable === true;

const classifyOne = (error: unknown): DurableObjectFailure | null => {
  const message = messageOf(error);
  if (message !== null) {
    const normalized = message.trim().toLowerCase();
    if (normalized === DESTROYED_MESSAGE) {
      return { kind: "destroyed", disposition: "session_dead" };
    }
    for (const pattern of MESSAGE_PATTERNS) {
      if (normalized.includes(pattern.fragment)) return pattern.failure;
    }
  }
  // Checked last: the message is the more specific signal, and the runtime sets
  // `retryable` on some of the same errors.
  if (isRuntimeRetryable(error)) return { kind: "retryable", disposition: "transient" };
  return null;
};

/**
 * Recognize a Cloudflare platform Durable Object failure.
 *
 * Accepts whatever the caller happens to be holding: the raw `Error` a stub RPC
 * rejected with, an `Error` that wrapped it as its `cause`, or an Effect
 * `Cause` — the DO seam only ever sees the last of those, and forcing every
 * call site to unwrap first is how a classifier ends up with three subtly
 * different copies.
 *
 * Returns `null` for anything unrecognized — the caller must then treat the
 * error exactly as it did before this module existed.
 */
export const classifyDurableObjectError = (error: unknown): DurableObjectFailure | null => {
  if (Cause.isCause(error)) {
    for (const inner of Cause.prettyErrors(error)) {
      const failure = classifyDurableObjectError(inner);
      if (failure) return failure;
    }
    return null;
  }
  let current: unknown = error;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH && current !== null && current !== undefined; ) {
    const failure = classifyOne(current);
    if (failure) return failure;
    depth += 1;
    if (typeof current !== "object") break;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return null;
};

/**
 * Render a classified platform failure as the MCP protocol error the client
 * should act on.
 *
 * Both branches reuse envelopes the MCP host already speaks, because the client
 * side of this is not new: a dead session id has always been "reconnect", and a
 * transient dependency failure has always been a 503 carrying `Retry-After`.
 * The only thing that was missing is that a platform reset never reached
 * either, and fell out of the worker as an unhandled 500 instead.
 *
 * The JSON-RPC code is -32001 for both; the HTTP STATUS is the discriminator
 * clients act on — 404 = the id is dead, mint a new session; 503 = retry the
 * SAME id after the advertised delay.
 */
export const durableObjectFailureResponse = (failure: DurableObjectFailure): Response =>
  failure.disposition === "session_dead"
    ? jsonRpcErrorBody(404, -32001, "Session timed out, please reconnect")
    : jsonRpcErrorBody(503, -32001, "MCP session is restarting, please retry", {
        retryAfterSeconds: UNAVAILABLE_RETRY_AFTER_SECONDS,
      });
