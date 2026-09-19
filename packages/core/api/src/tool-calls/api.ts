// ---------------------------------------------------------------------------
// Tool call log HTTP API — the audit trail.
//
// One row per tool call that reached the executor, including the ones a policy
// blocked and the approvals a caller declined. Read-only by construction: a
// log a caller can edit is not evidence, so there is no write endpoint and no
// delete. Owner-scoped like the rest of the API, so no owner travels on the
// wire — a caller reads back exactly the calls its own scope may see.
// ---------------------------------------------------------------------------

import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { InternalError, Owner } from "@executor-js/sdk/shared";
import { TOOL_CALL_LIST_MAX_LIMIT } from "@executor-js/sdk";

const ToolCallOutcome = Schema.Literals(["ok", "fail", "blocked", "declined", "error"]);

/** How the caller authenticated — see `ToolCallClientKind`. */
const ToolCallClientKind = Schema.Literals(["api_key", "oauth_client", "session", "cli"]);

const ToolCallClientResponse = Schema.Struct({
  kind: ToolCallClientKind,
  /** The credential's own id (API key id, OAuth client id), when it has one. */
  id: Schema.NullOr(Schema.String),
  /** Its human label: the key's name, the OAuth client's registered name. */
  name: Schema.NullOr(Schema.String),
});

const ToolCallResponse = Schema.Struct({
  id: Schema.String,
  owner: Owner,
  /** The address as called, e.g. `github.org.main.repos.get`. */
  address: Schema.String,
  /** Null for static tools, which have no connection behind them. */
  integration: Schema.NullOr(Schema.String),
  connection: Schema.NullOr(Schema.String),
  tool: Schema.NullOr(Schema.String),
  outcome: ToolCallOutcome,
  errorCode: Schema.NullOr(Schema.String),
  errorMessage: Schema.NullOr(Schema.String),
  /** The policy that governed the call, when a rule matched it. */
  policyAction: Schema.NullOr(Schema.String),
  policyPattern: Schema.NullOr(Schema.String),
  durationMs: Schema.Number,
  /** Top-level argument names. Never their values — see `tool-call-log.ts`. */
  argKeys: Schema.NullOr(Schema.Array(Schema.String)),
  /** The member who ran the call, even when the row is owned by the org.
   *  Null for calls recorded before this was kept. */
  actor: Schema.NullOr(Schema.String),
  actorLabel: Schema.NullOr(Schema.String),
  /** The credential the call came in on. Null when the host did not say. */
  client: Schema.NullOr(ToolCallClientResponse),
  /** Epoch milliseconds, like every other timestamp on this API. */
  createdAt: Schema.Number,
});

/** One distinct client in the visible log. */
const ToolCallClientSummaryResponse = Schema.Struct({
  kind: ToolCallClientKind,
  name: Schema.NullOr(Schema.String),
  calls: Schema.Number,
  /** Epoch milliseconds. */
  lastCallAt: Schema.Number,
});

/**
 * Query filters.
 *
 * `since` is epoch milliseconds rather than a date string: it is what the
 * other endpoints already put on the wire, and it survives a round trip
 * through a URL without a timezone argument.
 */
const ListToolCallsQuery = Schema.Struct({
  integration: Schema.optional(Schema.String),
  connection: Schema.optional(Schema.String),
  outcome: Schema.optional(ToolCallOutcome),
  since: Schema.optional(Schema.FiniteFromString),
  limit: Schema.optional(
    Schema.FiniteFromString.check(
      Schema.isBetween({ minimum: 1, maximum: TOOL_CALL_LIST_MAX_LIMIT }),
    ),
  ),
  // Paging. Bounded like every other numeric input: an unbounded offset is a
  // cheap way to make the database walk the whole partition.
  offset: Schema.optional(
    Schema.FiniteFromString.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  ),
  /** Substring match on the address. Bounded: nobody types 200 characters of
   *  tool address, and an unbounded pattern is free load on the database. */
  search: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  /** Exact client name ("Claude Code"). Bounded like `search`. */
  client: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});

export const ToolCallsApi = HttpApiGroup.make("toolCalls")
  .add(
    HttpApiEndpoint.get("list", "/tool-calls", {
      query: ListToolCallsQuery,
      success: Schema.Array(ToolCallResponse),
      error: InternalError,
    }),
  )
  .add(
    // The clients seen in the caller's visible log, most recently active first
    // — the choices for the Activity page's client filter.
    HttpApiEndpoint.get("clients", "/tool-calls/clients", {
      success: Schema.Array(ToolCallClientSummaryResponse),
      error: InternalError,
    }),
  );
