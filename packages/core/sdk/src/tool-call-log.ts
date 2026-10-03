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

/**
 * How the caller authenticated, as far as the host could tell:
 *
 *   - `api_key`      a personal API key presented as a bearer token
 *   - `oauth_client` an MCP client that signed in over OAuth (Claude Code,
 *                    Cursor, Codex, …) — named by its own registration
 *   - `session`      the browser console, on the signed-in user's cookie
 *   - `cli`          a CLI login (device authorization) bearer session
 */
export type ToolCallClientKind = "api_key" | "oauth_client" | "session" | "cli";

export const TOOL_CALL_CLIENT_KINDS = [
  "api_key",
  "oauth_client",
  "session",
  "cli",
] as const satisfies readonly ToolCallClientKind[];

/**
 * Who is calling, handed to the executor by the host — the only layer that
 * sees the credential. Stamped onto every audit row the executor writes, so a
 * row answers "which agent did this" and not just "which user".
 */
export interface ToolCallCaller {
  readonly kind: ToolCallClientKind;
  /** The credential's own id (API key id, OAuth client id); null when the
   *  credential has none worth keeping (a browser session). */
  readonly id: string | null;
  /** Human label: the API key's name, the OAuth client's registered name. */
  readonly name: string | null;
  /** The acting member as a human reads it (email, else display name). */
  readonly actorLabel?: string | null;
}

/** The client behind a recorded call. */
export interface ToolCallClient {
  readonly kind: ToolCallClientKind;
  readonly id: string | null;
  readonly name: string | null;
}

/** One distinct client seen in the log, for a filter or a report. */
export interface ToolCallClientSummary {
  readonly kind: ToolCallClientKind;
  readonly name: string | null;
  readonly calls: number;
  readonly lastCallAt: Date;
}

/** How many of the newest calls `toolCalls.clients()` looks at. A client with
 *  no call in that window is not one a filter needs to offer. */
export const TOOL_CALL_CLIENTS_WINDOW = 5000;

/** Longest label kept. An OAuth client names itself at registration, so this
 *  is caller-controlled text and is bounded like any other. */
export const TOOL_CALL_LABEL_LIMIT = 80;

// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * Clean a label before it is stored: collapse whitespace, drop control
 * characters, bound the length. An OAuth `client_name` is whatever the client
 * registered, and it ends up rendered in the console.
 */
export const cleanToolCallLabel = (value: string | null | undefined): string | null => {
  if (value == null) return null;
  const cleaned = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > TOOL_CALL_LABEL_LIMIT
    ? `${cleaned.slice(0, TOOL_CALL_LABEL_LIMIT)}…`
    : cleaned;
};

export const isToolCallClientKind = (value: unknown): value is ToolCallClientKind =>
  value === "api_key" || value === "oauth_client" || value === "session" || value === "cli";

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
  /** The member who ran the call (subject id), even when the row is owned by
   *  the org. Null for rows written before this was recorded. */
  readonly actor: string | null;
  readonly actorLabel: string | null;
  /** The credential the call came in on. Null for rows written before this
   *  was recorded, or by a host that does not say. */
  readonly client: ToolCallClient | null;
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
  /** Substring match on the address as called — the one free-text field a row
   *  has that is safe to search: this file wrote it, not an upstream. */
  readonly search?: string;
  /** Only calls that came in on a client with this name ("Claude Code"). By
   *  name, not id: one client re-registers under a new id, and the question
   *  is what the agent did, not which registration it used. */
  readonly clientName?: string;
}

export interface PruneToolCallsInput {
  /** Rows created strictly before this instant are removed. */
  readonly before: Date;
}

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
  actor: row.actor == null || row.actor === "" ? null : String(row.actor),
  actorLabel: row.actor_label == null ? null : String(row.actor_label),
  client: isToolCallClientKind(row.client_kind)
    ? {
        kind: row.client_kind,
        id: row.client_id == null ? null : String(row.client_id),
        name: row.client_name == null ? null : String(row.client_name),
      }
    : null,
  createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
});
