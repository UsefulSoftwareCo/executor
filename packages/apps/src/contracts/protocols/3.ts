/**
 * Host protocol 3: protocol 2 plus the app's own failure detail. Operation, evaluation and
 * declaration failures carry the error name and bounded, secret-free message the app raised, and
 * workflow failures carry the failing step and app error. Queries and mutations that exceed a
 * database budget, and declarations with a reserved database field, fail with their named error.
 *
 * This protocol is released and frozen once merged. `bun run check` compares `protocol3` with
 * `packages/apps/protocols/3.json`. The module imports only `effect` and earlier protocol modules,
 * so no change elsewhere can alter it; define the next protocol to change the wire format.
 * See notes/apps-publishing.md.
 */
import { Schema } from "effect";
import {
  CacheCommand,
  CacheReply,
  DeclaredRequirements,
  ElicitationFailed,
  ElicitationReply,
  FormElicitation,
  HostAccountsInvalid,
  HostInputInvalid,
  HostInvocation,
  HostOperationNotFound,
  HostOutputInvalid,
  HostRequest,
  HostRequestInvalid,
  HostToolApprovalRequired,
  HostToolBlocked,
  HostToolNotFound,
  HostToolPolicyFailed,
  JsonValue,
  McpError,
  OpenapiResponseError,
  ProviderError,
  SkillLoadFailed,
  WorkflowControlCommand,
  WorkflowRpcCommand,
  protocol1,
} from "./1.ts";
import { SkillCatalogResponse } from "./2.ts";

export {
  DeclaredAuthMethod,
  DeclaredProvider,
  DeclaredRequirements,
  ResolvedAccount,
  ResolvedAccounts,
  TrustedToolApproval,
  InvocationDeadline,
  HostedTool,
  HostedToolSummary,
  HostRequest,
  HostRequestInvalid,
  HostAccountsInvalid,
  HostOperationNotFound,
  HostToolNotFound,
  InputProblem,
  maxInputProblems,
  HostInputInvalid,
  HostToolBlocked,
  HostToolApprovalRequired,
  HostToolPolicyFailed,
  HostOutputInvalid,
  HostInvocation,
} from "./1.ts";
export { SkillSources, SkillCatalogResponse } from "./2.ts";

/** Longest failure message carried across the runtime boundary. */
export const maxFailureMessageLength = 2048;
/**
 * `app` for errors thrown by authored code, `storage` for app data failures the host raised, and
 * `service` for an external API the app called through a framework helper.
 */
export const FailureSource = Schema.Literals(["app", "storage", "service"]);
/** The thrown error's name, such as `TypeError`, or the host error's tag. */
export const FailureName = Schema.String.check(Schema.isMaxLength(128));
/** A stable host failure code, such as an app data reason, or the thrown error's own `code`. */
export const FailureCode = Schema.String.check(Schema.isMaxLength(128));
/** Bounded, with the invocation's account secrets replaced. */
export const FailureMessage = Schema.String.check(Schema.isMaxLength(maxFailureMessageLength));

/**
 * Where and why a run failed: the failing step and the error the app's own code raised, its
 * message bounded and with account secrets replaced. Runs from before these fields existed have none.
 */
export const WorkflowFailureDetail = {
  step: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  errorName: Schema.optionalKey(FailureName),
  message: Schema.optionalKey(FailureMessage),
};
/** Failures cross host boundaries as reason codes plus the app's own bounded error detail. */
export class WorkflowFailure extends Schema.TaggedError<WorkflowFailure>()("WorkflowFailure", {
  ...WorkflowFailureDetail,
  reason: Schema.Literals([
    "unavailable",
    "not_found",
    "input",
    "output",
    "operation",
    "approval",
    "credentials",
    "terminated",
    "execution",
    "conflict",
    "engine",
  ]),
  retryable: Schema.Boolean,
}) {}
/** Protocol 3's workflow step reply, carrying the failing step and app error. */
export const WorkflowRpcResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: JsonValue }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkflowFailure }),
]);
export type WorkflowRpcResult = typeof WorkflowRpcResult.Type;

/**
 * The budget a query or mutation exhausted. `pageSize` bounds one take(n) or paginate call;
 * `valueBytes` bounds one stored row; the rest accumulate across the whole invocation.
 */
export const DatabaseLimit = Schema.Literals([
  "scanCalls",
  "directGets",
  "rowsRead",
  "rowsReturned",
  "pageSize",
  "bytesRead",
  "writes",
  "valueBytes",
]);
export type DatabaseLimit = typeof DatabaseLimit.Type;
/** A query or mutation exceeded one of its database budgets. Nothing it wrote is committed. */
export class DatabaseLimitExceeded extends Schema.TaggedError<DatabaseLimitExceeded>()(
  "DatabaseLimitExceeded",
  {
    limit: DatabaseLimit,
    maximum: Schema.Int,
    requested: Schema.Int,
  },
) {}

/** Host-owned row metadata that authored tables cannot declare. */
export const reservedFieldNames = ["id", "createdAt", "updatedAt"] as const;
/** A table declared a field the host adds to every row. */
export class DatabaseFieldReserved extends Schema.TaggedError<DatabaseFieldReserved>()(
  "DatabaseFieldReserved",
  {
    table: Schema.String,
    field: Schema.Literals(reservedFieldNames),
  },
) {}

/** Protocol 3's failure detail, as released: the app error's source, name, code and message. */
const FailureDetail = {
  source: Schema.optionalKey(FailureSource),
  errorName: Schema.optionalKey(FailureName),
  code: Schema.optionalKey(FailureCode),
  message: Schema.optionalKey(FailureMessage),
};

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
/** An app operation failed. Carries the app's own error name and bounded, secret-free message. */
export class HostOperationFailed extends Schema.TaggedError<HostOperationFailed>()(
  "HostOperationFailed",
  FailureDetail,
) {}

/**
 * Safe error envelope. Author failures carry only their name and bounded message with account
 * secrets replaced; no source, account fields, stack or cause value is serialized.
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

/** Every message of protocol 3, in the order its snapshot records them. */
export const protocol3 = {
  version: 3,
  schemas: {
    invocation: HostInvocation,
    request: HostRequest,
    response: HostResponse,
    requirements: DeclaredRequirements,
    tools: protocol1.schemas.tools,
    toolSummaries: protocol1.schemas.toolSummaries,
    skills: SkillCatalogResponse,
    elicitationRequest: FormElicitation,
    elicitationReply: ElicitationReply,
    workflowStep: WorkflowRpcCommand,
    workflowStepReply: WorkflowRpcResult,
    workflowControl: WorkflowControlCommand,
    cacheCommand: CacheCommand,
    cacheReply: CacheReply,
  },
} as const;
