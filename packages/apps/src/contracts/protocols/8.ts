/**
 * Host protocol 8: protocol 7 plus upstream failure detail.
 *
 * Declaration, evaluation and operation failures may carry the thrown error's own scalar fields,
 * such as a spec compiler's `reason` and `pointer`, beside its name, code and message. A provider
 * failure may carry the phase it happened in and the error code and description the service
 * stated, and an MCP failure the JSON-RPC error the server answered with. Older bundles never send
 * them, so their replies are protocol 8 replies without the detail. Every other message is
 * protocol 7's, re-exported unchanged.
 *
 * Once released this protocol is frozen like the earlier ones: `bun run check` compares `protocol8`
 * with `packages/apps/protocols/8.json`. The module imports only `effect` and earlier protocol
 * modules, so no change elsewhere can alter it. Define the next protocol instead of editing this
 * file. See notes/apps-publishing.md.
 */
import { Schema } from "effect";
import {
  AccountId,
  ElicitationFailed,
  JsonValue,
  OpenapiResponseError,
  SkillLoadFailed,
} from "./1.ts";
import {
  DatabaseFieldReserved,
  DatabaseLimitExceeded,
  FailureCode,
  FailureMessage,
  FailureName,
  FailureSource,
  WorkflowFailure,
} from "./3.ts";
import {
  HostAccountsInvalid,
  HostedRouter as PreviousRouter,
  HostedCatalog as PreviousCatalog,
  HostedCatalogSummary as PreviousCatalogSummary,
  HostInputInvalid,
  HostKindMismatch,
  HostOperationNotFound,
  HostOutputInvalid,
  HostRequestInvalid,
  HostToolApprovalRequired,
  HostToolBlocked,
  HostToolNotFound,
  HostToolPolicyFailed,
  protocol7,
} from "./7.ts";

export * from "./7.ts";

/** Most fields of one thrown error carried across the runtime boundary. */
export const maxFailureFields = 8;
/** Longest text field value carried across the runtime boundary. */
export const maxFailureFieldLength = 256;
/** A field name as the error's code spells it, such as `reason` or `pointer`. */
export const FailureFieldName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/),
);
/** Bounded text with account secrets replaced, a finite number, or a boolean. */
export const FailureFieldValue = Schema.Union([
  Schema.String.check(Schema.isMaxLength(maxFailureFieldLength)),
  Schema.Finite,
  Schema.Boolean,
]);
/**
 * The thrown error's own scalar fields beside its name, code and message, such as the `reason`
 * and `pointer` a spec compiler sets. Nested values, stacks and causes are never carried.
 */
export const FailureFields = Schema.Record(FailureFieldName, FailureFieldValue).check(
  Schema.isMaxProperties(maxFailureFields),
);
export type FailureFields = typeof FailureFields.Type;

/**
 * The error an app's own code raised, or the specific host failure it hit. Stacks and cause
 * values stay private. Builds from before these fields existed send none.
 */
export const FailureDetail = {
  source: Schema.optionalKey(FailureSource),
  errorName: Schema.optionalKey(FailureName),
  code: Schema.optionalKey(FailureCode),
  message: Schema.optionalKey(FailureMessage),
  fields: Schema.optionalKey(FailureFields),
};

/** Longest error message a service stated, as carried across the runtime boundary. */
export const maxUpstreamMessageLength = 1024;
/**
 * The error a service stated in its own response: a JSON-RPC error's code and message, or an
 * OAuth Bearer error code and description. Bounded, with the invocation's account secrets replaced.
 */
export const UpstreamError = Schema.Struct({
  code: Schema.Union([
    Schema.Int,
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  ]),
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(maxUpstreamMessageLength))),
});
export type UpstreamError = typeof UpstreamError.Type;

/** Where a service failed: setting up a session, listing tools, or running one. */
export const FailurePhase = Schema.Literals(["connect", "discover", "call"]);
export type FailurePhase = typeof FailurePhase.Type;

/**
 * Protocol 8's provider failure, as released: protocol 1's with the phase the failure happened in
 * and the error code and description the service stated. Account secrets in that text are replaced.
 */
export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  reason: Schema.Literals(["unauthorized", "forbidden", "rate_limited", "unavailable", "rejected"]),
  status: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
  accountId: Schema.optional(AccountId),
  phase: Schema.optional(FailurePhase),
  upstream: Schema.optional(UpstreamError),
}) {}

/** Protocol 8's MCP failure, as released: protocol 1's with the JSON-RPC error the server stated. */
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
}) {}

/**
 * The module or declared capability shape could not be hosted. The detail names what the app
 * declared wrongly; declarations bind no accounts.
 */
export class HostDeclarationInvalid extends Schema.TaggedError<HostDeclarationInvalid>()(
  "HostDeclarationInvalid",
  FailureDetail,
) {}
/** Fresh app evaluation failed before calling a tool. */
export class HostEvaluationFailed extends Schema.TaggedError<HostEvaluationFailed>()(
  "HostEvaluationFailed",
  FailureDetail,
) {}
/** An app operation failed. Carries the app's own error name, code, fields and bounded message. */
export class HostOperationFailed extends Schema.TaggedError<HostOperationFailed>()(
  "HostOperationFailed",
  FailureDetail,
) {}

/** Why one router's tools could not be read. The rest of the app's catalog is unaffected. */
export const HostRouterError = Schema.Union([
  ProviderError,
  McpError,
  SkillLoadFailed,
  HostDeclarationInvalid,
  HostEvaluationFailed,
]);
export type HostRouterError = typeof HostRouterError.Type;

/** One router in a live catalog, whose error carries protocol 8's detail. */
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

/** Every message of protocol 8, in the order its snapshot records them. */
export const protocol8 = {
  version: 8,
  schemas: {
    ...protocol7.schemas,
    response: HostResponse,
    catalog: HostedCatalog,
    catalogSummary: HostedCatalogSummary,
  },
} as const;
