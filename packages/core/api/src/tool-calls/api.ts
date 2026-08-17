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
  /** Epoch milliseconds, like every other timestamp on this API. */
  createdAt: Schema.Number,
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
});

export const ToolCallsApi = HttpApiGroup.make("toolCalls").add(
  HttpApiEndpoint.get("list", "/tool-calls", {
    query: ListToolCallsQuery,
    success: Schema.Array(ToolCallResponse),
    error: InternalError,
  }),
);
