/**
 * The tool call log — how a settled call becomes an audit row.
 *
 * Only the pure shape lives here (outcome classification, argument-name
 * extraction, row mapping); the write itself is in `executor.ts`, wrapped
 * around `execute` so every ending a call can have passes through it.
 *
 * What this deliberately does NOT keep: arguments, results, and any text that
 * came from outside. They carry the caller's data, and a credential-shaped
 * argument carries the credential. Two rules make that concrete:
 *
 *   1. Only messages this file WROTE are stored. An upstream failure keeps its
 *      `code` — an enumerable identifier — never its message, which plugins
 *      derive from upstream error bodies and which routinely echoes back the
 *      request (and with it, whatever was in it).
 *   2. Argument NAMES are stored, values never — and a name only survives if
 *      it looks like a parameter rather than a payload.
 *
 * Compare `@executor-js/analytics`, which is anonymous by construction and
 * drops the address/integration this table exists to keep.
 */

import { Cause, Exit, Predicate } from "effect";

import { isToolResult } from "./tool-result";
import type { Owner } from "./ids";
import type { ToolCallLogRow, ToolCallOutcome } from "./core-schema";

/** One recorded call, as callers read it back. */
export interface ToolCall {
  readonly id: string;
  readonly owner: Owner;
  /** The address as called, e.g. `github.org.main.repos.get`. */
  readonly address: string;
  /** Null for static tools (core-tools, plugin namespaces). */
  readonly integration: string | null;
  readonly connection: string | null;
  readonly tool: string | null;
  readonly outcome: ToolCallOutcome;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  /** The policy that governed the call, when a rule matched. */
  readonly policyAction: string | null;
  readonly policyPattern: string | null;
  readonly durationMs: number;
  /** Top-level argument names, never their values. */
  readonly argKeys: readonly string[] | null;
  readonly createdAt: Date;
}

export interface ListToolCallsInput {
  readonly integration?: string;
  readonly connection?: string;
  readonly outcome?: ToolCallOutcome;
  /** Only calls at or after this instant. */
  readonly since?: Date;
  readonly limit?: number;
  /** Rows to skip, for paging. The log is append-only at the top, so a page
   *  can shift while being browsed; fine for eyeballing, use `since` for
   *  programmatic sweeps. */
  readonly offset?: number;
}

export interface PruneToolCallsInput {
  /** Rows created strictly before this instant are removed. */
  readonly before: Date;
}

/**
 * The longest a tool call may wait on its own audit row.
 *
 * The write is awaited (see `executor.ts`) so a per-request host cannot tear
 * the executor down mid-insert and lose the row. This is the cap on what that
 * choice can cost when the database is unwell: past it the row is dropped with
 * a warning and the call returns.
 */
export const TOOL_CALL_LOG_WRITE_TIMEOUT = "2 seconds";

export const TOOL_CALL_LIST_DEFAULT_LIMIT = 100;
export const TOOL_CALL_LIST_MAX_LIMIT = 1000;

/** A log read is a page, never the whole table: the log grows without bound. */
export const clampToolCallLimit = (limit: number | undefined): number => {
  if (limit == null || !Number.isFinite(limit)) return TOOL_CALL_LIST_DEFAULT_LIMIT;
  return Math.min(TOOL_CALL_LIST_MAX_LIMIT, Math.max(1, Math.floor(limit)));
};

/** One line of context, never a response body. */
export const TOOL_CALL_MESSAGE_LIMIT = 300;

/**
 * What an error code may look like before it is stored.
 *
 * `ToolError.code` is typed as any string, so a plugin is free to forward an
 * upstream identifier — or an upstream body — straight into it. An audit row
 * keeps codes because they are enumerable labels; anything that is not shaped
 * like one is dropped rather than persisted, since the outcome column already
 * says what happened.
 */
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

const safeCode = (code: unknown): string | null =>
  typeof code === "string" && ERROR_CODE.test(code) ? code : null;
/** Enough parameter names to recognise a call; a pathological arg map is cut. */
export const TOOL_CALL_ARG_KEY_LIMIT = 64;

const truncate = (message: string): string =>
  message.length > TOOL_CALL_MESSAGE_LIMIT
    ? `${message.slice(0, TOOL_CALL_MESSAGE_LIMIT)}…`
    : message;

export interface ToolCallOutcomeSummary {
  readonly outcome: ToolCallOutcome;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

/**
 * Classify how a call ended.
 *
 * The subtle case is `fail`: a tool's own error result rides the SUCCESS
 * channel by design (expected failures are values, not defects), so a log
 * that only looked at the Effect channel would record an upstream 404 or an
 * expired credential as a healthy call.
 */
export const toolCallOutcome = (exit: Exit.Exit<unknown, unknown>): ToolCallOutcomeSummary => {
  if (Exit.isSuccess(exit)) {
    const value = exit.value;
    if (isToolResult(value) && !value.ok) {
      // The code only, and only if it is shaped like one. `error.message` is
      // upstream text — the OpenAPI plugin lifts it straight out of the
      // response body — so storing it would make an upstream echo of a token
      // or a customer record durable, and readable through the log API.
      return { outcome: "fail", errorCode: safeCode(value.error.code), errorMessage: null };
    }
    return { outcome: "ok", errorCode: null, errorMessage: null };
  }

  const failure = unwrapInvocationCause(Exit.isFailure(exit) ? causeFailure(exit) : undefined);
  if (Predicate.isTagged("ToolBlockedError")(failure)) {
    const pattern = (failure as { readonly pattern?: unknown }).pattern;
    return {
      outcome: "blocked",
      errorCode: "tool_blocked",
      errorMessage: typeof pattern === "string" ? truncate(`blocked by pattern ${pattern}`) : null,
    };
  }
  if (Predicate.isTagged("ElicitationDeclinedError")(failure)) {
    const action = (failure as { readonly action?: unknown }).action;
    return {
      outcome: "declined",
      errorCode: "approval_declined",
      errorMessage: typeof action === "string" ? truncate(`approval ${action}`) : null,
    };
  }
  // Everything else keeps its TAG and nothing more: a plugin's failure message
  // is upstream text under the same rule as `fail` above.
  return { outcome: "error", errorCode: failureTag(failure), errorMessage: null };
};

/**
 * A tool handler may itself raise a decline (the `elicit` capability is handed
 * to handlers, not only to the executor), and `execute` wraps any handler
 * failure in a `ToolInvocationError` on its way out. Unwrap one level so that
 * decline is recorded as a decline instead of a generic error.
 */
const unwrapInvocationCause = (failure: unknown): unknown => {
  if (!Predicate.isTagged("ToolInvocationError")(failure)) return failure;
  const inner = (failure as { readonly cause?: unknown }).cause;
  return inner ?? failure;
};

// A defect (an unexpected throw) is as much an audit fact as a typed failure:
// the call ended and the caller got nothing back. `squash` gives the first
// failure or defect in the cause, whichever the call actually died of.
const causeFailure = (exit: Exit.Failure<unknown, unknown>): unknown => Cause.squash(exit.cause);

// An audit row labels whatever the call died of, including failures this
// package has never heard of — there is no tag to match against ahead of time,
// which is what the rule below normally protects.
const failureTag = (failure: unknown): string | null => {
  if (failure == null || typeof failure !== "object") return null;
  // oxlint-disable-next-line executor/no-manual-tag-check -- boundary: labelling an unknown failure for the audit log
  const tag = (failure as { readonly _tag?: unknown })._tag;
  // Tags are this codebase's own labels, but the same shape rule applies: a
  // failure can come from anywhere, including a plugin that put text in one.
  return safeCode(tag);
};

/** The longest a parameter name can plausibly be. */
export const TOOL_CALL_ARG_KEY_MAX_LENGTH = 64;

/** What a tool parameter looks like: an identifier, not a payload. */
const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_.[\]-]*$/;

/** Names that are themselves shaped like a credential — a caller can put
 *  anything in a key, and `execute` accepts `unknown` arguments. */
const CREDENTIAL_SHAPED =
  /^(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-|ya29\.|AKIA|eyJ)|^[A-Fa-f0-9]{32,}$/;

/**
 * The top-level argument NAMES, in call order.
 *
 * Names describe the shape of a call ("it passed `siteUrl` and `body`")
 * without exposing what was in it. But a name is caller-controlled too —
 * `execute` takes `unknown` args, so `{ "ghp_realtoken": null }` is a
 * reachable shape — hence the filter: only identifier-shaped, bounded names
 * that do not themselves look like a secret survive. Non-object arguments have
 * no names, and neither does an absent one.
 */
export const toolCallArgKeys = (args: unknown): readonly string[] | null => {
  if (args == null || typeof args !== "object" || Array.isArray(args)) return null;
  const keys = Object.keys(args as Record<string, unknown>).filter(
    (key) =>
      key.length <= TOOL_CALL_ARG_KEY_MAX_LENGTH &&
      PARAMETER_NAME.test(key) &&
      !CREDENTIAL_SHAPED.test(key),
  );
  if (keys.length === 0) return null;
  return keys.slice(0, TOOL_CALL_ARG_KEY_LIMIT);
};

const decodeArgKeys = (value: unknown): readonly string[] | null => {
  if (!Array.isArray(value)) return null;
  const keys = value.filter((entry): entry is string => typeof entry === "string");
  return keys.length > 0 ? keys : null;
};

const isToolCallOutcome = (value: unknown): value is ToolCallOutcome =>
  value === "ok" ||
  value === "fail" ||
  value === "blocked" ||
  value === "declined" ||
  value === "error";

export const rowToToolCall = (row: ToolCallLogRow): ToolCall => ({
  id: String(row.id),
  owner: row.owner as Owner,
  address: String(row.address),
  integration: row.integration == null ? null : String(row.integration),
  connection: row.connection == null ? null : String(row.connection),
  tool: row.tool == null ? null : String(row.tool),
  // A row whose outcome cannot be read is still a call that happened; it is
  // reported as `error` rather than dropped from the audit.
  outcome: isToolCallOutcome(row.outcome) ? row.outcome : "error",
  errorCode: row.error_code == null ? null : String(row.error_code),
  errorMessage: row.error_message == null ? null : String(row.error_message),
  policyAction: row.policy_action == null ? null : String(row.policy_action),
  policyPattern: row.policy_pattern == null ? null : String(row.policy_pattern),
  durationMs: Number(row.duration_ms ?? 0),
  argKeys: decodeArgKeys(row.arg_keys),
  createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
});
