/**
 * Host protocol 9: protocol 8 plus detail that chooses a failure's explanation.
 *
 * An MCP failure may say that the refused request carried the session the server issued at
 * initialization (`session`). A skill loader failure may name what its service's answer points to
 * as missing (`missing`: the repository, or the branch or tag). These fields only choose the copy:
 * they cross from the app's code, so they never show whose side a failure is on. Older bundles
 * never send them, so their replies are protocol 9 replies without the detail. Every other message
 * is protocol 8's, re-exported unchanged.
 *
 * Once released this protocol is frozen like the earlier ones: `bun run check` compares `protocol9`
 * with `packages/apps/protocols/9.json`. The module imports only `effect` and earlier protocol
 * modules, so no change elsewhere can alter it. Define the next protocol instead of editing this
 * file. See notes/apps-publishing.md.
 */
import { Schema } from "effect";
import { ElicitationFailed, JsonValue, OpenapiResponseError } from "./1.ts";
import { DatabaseFieldReserved, DatabaseLimitExceeded, WorkflowFailure } from "./3.ts";
import {
  HostAccountsInvalid,
  HostDeclarationInvalid,
  HostedRouter as PreviousRouter,
  HostedCatalog as PreviousCatalog,
  HostedCatalogSummary as PreviousCatalogSummary,
  HostEvaluationFailed,
  HostInputInvalid,
  HostKindMismatch,
  HostOperationFailed,
  HostOperationNotFound,
  HostOutputInvalid,
  HostRequestInvalid,
  HostToolApprovalRequired,
  HostToolBlocked,
  HostToolNotFound,
  HostToolPolicyFailed,
  ProviderError,
  UpstreamError,
  protocol8,
} from "./8.ts";

export * from "./8.ts";

/** Protocol 9's MCP failure: protocol 8's, with `session`. */
export class McpError extends Schema.TaggedError<McpError>()("McpError", {
  phase: Schema.Literals(["connect", "discover", "call", "schema", "transport"]),
  reason: Schema.Literals([
    "request",
    "unauthorized",
    "invalid_response",
    "timeout",
    "invalid_input",
  ]),
  status: Schema.optional(Schema.Number),
  upstream: Schema.optional(UpstreamError),
  session: Schema.optional(Schema.Literal(true)),
}) {}

/** Protocol 9's skill loader failure: protocol 1's, with `missing`. */
export class SkillLoadFailed extends Schema.TaggedError<SkillLoadFailed>()("SkillLoadFailed", {
  reason: Schema.Literals([
    "source",
    "request",
    "rate_limited",
    "document",
    "limit",
    "changed",
    "encoding",
  ]),
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  status: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
  missing: Schema.optional(Schema.Literals(["repository", "ref"])),
}) {}

/** Why one router's tools could not be read. The rest of the app's catalog is unaffected. */
export const HostRouterError = Schema.Union([
  ProviderError,
  McpError,
  SkillLoadFailed,
  HostDeclarationInvalid,
  HostEvaluationFailed,
]);
export type HostRouterError = typeof HostRouterError.Type;

/** One router in a live catalog, whose error carries protocol 9's detail. */
export const HostedRouter = Schema.Struct({
  ...PreviousRouter.fields,
  error: Schema.optionalKey(HostRouterError),
});
export type HostedRouter = typeof HostedRouter.Type;

/** A live evaluation's tools and the routers that group them. */
export const HostedCatalog = Schema.Struct({
  ...PreviousCatalog.fields,
  routers: Schema.Array(HostedRouter),
});
export type HostedCatalog = typeof HostedCatalog.Type;

/** A catalog without tool schemas. Browsing lists these and reads one full tool on selection. */
export const HostedCatalogSummary = Schema.Struct({
  ...PreviousCatalogSummary.fields,
  routers: Schema.Array(HostedRouter),
});
export type HostedCatalogSummary = typeof HostedCatalogSummary.Type;

/**
 * Safe error envelope. Author failures carry only their name, code, scalar fields and bounded
 * message with account secrets replaced; no stack or cause value is serialized.
 */
export const HostError = Schema.Union([
  OpenapiResponseError,
  ProviderError,
  McpError,
  SkillLoadFailed,
  WorkflowFailure,
  HostRequestInvalid,
  HostAccountsInvalid,
  HostDeclarationInvalid,
  HostEvaluationFailed,
  HostOperationNotFound,
  HostOperationFailed,
  DatabaseLimitExceeded,
  DatabaseFieldReserved,
  HostToolNotFound,
  HostInputInvalid,
  HostOutputInvalid,
  HostToolBlocked,
  HostToolApprovalRequired,
  HostToolPolicyFailed,
  ElicitationFailed,
  HostKindMismatch,
]);
/** Expected host failures. */
export type HostError = typeof HostError.Type;

/** Portable response envelope; callers parse the success value for their operation. */
export const HostResponse = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    value: JsonValue,
    toolError: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: HostError }),
]);
/** Parsed response envelope. */
export type HostResponse = typeof HostResponse.Type;

/** Every message of protocol 9, in the order its snapshot records them. */
export const protocol9 = {
  version: 9,
  schemas: {
    ...protocol8.schemas,
    response: HostResponse,
    catalog: HostedCatalog,
    catalogSummary: HostedCatalogSummary,
  },
} as const;
