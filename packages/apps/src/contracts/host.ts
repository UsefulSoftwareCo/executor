export * from "./skills.ts";
import { SkillLoadFailed, type SkillFile } from "./skills.ts";
import { ProviderError } from "./provider-error.ts";
import { OpenapiResponseError } from "./api-response-error.ts";
export { ApiErrorResponse, OpenapiResponseError } from "./api-response-error.ts";
export { ProviderError } from "./provider-error.ts";
import {
  WorkflowCommand,
  WorkflowFailure,
  type WorkflowExecution,
  type WorkflowReplay,
  type WorkflowHostControls,
} from "./workflows.ts";
export * from "./workflows.ts";
import { OperationSchedule } from "./schedules.ts";
import { DatabaseSchema } from "@executor-js/app-data/contracts";
/** Portable framework dispatch contracts. Requests never carry account bindings. */
import { Context, Schema, type Effect, type Redacted } from "effect";
import { AccountId, JsonObject, JsonValue } from "./schema.ts";
import type { AppStorage } from "./storage.ts";
import type { InvocationTelemetry } from "@executor-js/telemetry";
export { AppStorageError, AppStorageUnavailable, StorageName, type AppStorage } from "./storage.ts";
import { ApprovalElicitation, ElicitationFailed, type ElicitationHandler } from "./elicitation.ts";
export {
  ElicitationLimits,
  defaultElicitationLimits,
  FormElicitation,
  ElicitationResponse,
  ElicitationReply,
  ElicitationFailed,
  type ElicitationHandler,
  ApprovalElicitation,
  ApprovalResponse,
  approvalElicitation,
} from "./elicitation.ts";
export { McpClientLimits, defaultMcpClientLimits } from "./mcp.ts";
import { WebhookCommand } from "./webhook-protocol.ts";
export * from "./webhook-protocol.ts";
import { ToolAnnotations } from "./tools.ts";

export { AccountId, HttpUrl } from "./schema.ts";
import { OAuth2Config } from "./provider.ts";
export { OAuthClientAuth, OAuthSecretClientAuth } from "./provider.ts";

/** Serializable auth methods shared with SDK hosts; protocol configuration has one schema. */
export const DeclaredAuthMethod = Schema.Union([
  Schema.Struct({ type: Schema.Literal("secrets"), label: Schema.String, fields: JsonObject }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[0].fields,
    response: JsonObject,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[1].fields,
    response: JsonObject,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[2].fields,
    response: JsonObject,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[3].fields,
    response: JsonObject,
  }),
]);

/** Serializable declaration of a provider's named authentication methods. */
export const DeclaredProvider = Schema.Struct({
  name: Schema.NonEmptyString,
  auth: Schema.Record(Schema.NonEmptyString, DeclaredAuthMethod),
});
/** Credential-free provider declaration; content matching remains host policy. */
export type DeclaredProvider = typeof DeclaredProvider.Type;

/** Account slots available without binding accounts or evaluating the app factory. */
export const DeclaredRequirements = Schema.Struct({
  /** Protocol support of this retained framework build, not an author-declared requirement. */
  capabilities: Schema.optionalKey(Schema.Struct({ skills: Schema.Literal(true) })),
  database: Schema.optionalKey(DatabaseSchema),
  accounts: Schema.Record(
    Schema.NonEmptyString,
    Schema.Struct({
      definition: DeclaredProvider,
      cardinality: Schema.Literals(["one", "many"]),
    }),
  ),
});
/** Parsed declared account requirements. */
export type DeclaredRequirements = typeof DeclaredRequirements.Type;

/** Host-resolved credentials for one stable saved account. Never a request DTO. */
export const ResolvedAccount = Schema.Struct({
  id: AccountId,
  provider: DeclaredProvider,
  method: Schema.NonEmptyString,
  fields: JsonObject,
});
/** Parsed host account binding. */
export type ResolvedAccount = typeof ResolvedAccount.Type;

/** Full saved selection resolved by the trusted caller; [] differs from a missing slot. */
export const ResolvedAccounts = Schema.Record(
  Schema.NonEmptyString,
  Schema.Union([ResolvedAccount, Schema.Array(ResolvedAccount)]),
);
/** Raw host inputs; the host boundary parses and redacts these immediately. */
export type ResolvedAccountsInput = typeof ResolvedAccounts.Encoded;
/** Parsed host selections, kept redacted until native account binding. */
export type ResolvedAccounts = typeof ResolvedAccounts.Type;

/** Trusted approval for one decoded call. Never accepted in public command JSON. */
export const TrustedToolApproval = Schema.Struct({ tool: Schema.NonEmptyString, input: JsonValue });
export type TrustedToolApproval = typeof TrustedToolApproval.Type;

/** Absolute Unix time in milliseconds; remote hosts enforce it inside the operation transaction. */
export const InvocationDeadline = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** Trusted invocation context, supplied separately from the Request. */
export interface HostContext {
  /** Trusted host deadline; never accepted in public operation JSON. */
  readonly deadline?: typeof InvocationDeadline.Type;
  /** Host-owned cache storage and refresh lifetime, separate from app database transactions. */
  readonly cache?: import("./cache.ts").HostCache;
  /** Packaged app text files supplied by the build bridge. Direct hosts may omit them for an empty package. */
  readonly files?: readonly SkillFile[];
  /** Private delivery capability. It is never accepted in public request JSON or stored in a build. */
  readonly workflowControls?: WorkflowHostControls;
  readonly workflow?: WorkflowExecution;
  readonly replay?: WorkflowReplay;
  readonly elicitation?: ElicitationHandler;
  /** Trusted in-process tracing capability; never decoded from a public request. */
  readonly telemetry?: InvocationTelemetry;
  readonly approval?: TrustedToolApproval;
  readonly storage?: AppStorage;
  readonly accounts: Redacted.Redacted<ResolvedAccounts>;
}

/** Serializable live tool metadata; executable callbacks never cross this boundary. */
export const HostedTool = Schema.Struct({
  schedules: Schema.optionalKey(Schema.Array(OperationSchedule)),
  name: Schema.NonEmptyString,
  description: Schema.String,
  inputSchema: JsonObject,
  readOnly: Schema.optionalKey(Schema.Boolean),
  title: Schema.optionalKey(Schema.String),
  outputSchema: Schema.optionalKey(JsonObject),
  annotations: Schema.optionalKey(ToolAnnotations),
  _meta: Schema.optionalKey(JsonObject),
});
/** Parsed live tool description. */
export type HostedTool = typeof HostedTool.Type;

/** Catalog entry without schemas. Browsing lists these and reads one full tool on selection. */
export const HostedToolSummary = HostedTool.mapFields(
  ({ inputSchema: _input, outputSchema: _output, _meta, ...fields }) => fields,
);
export type HostedToolSummary = typeof HostedToolSummary.Type;

/** Inspection commands. Earlier builds ignore detail and tools, so hosts reduce their results. */
export const inspectCommand = (tools?: readonly string[]) =>
  tools === undefined
    ? ({ operation: "inspect" } as const)
    : ({ operation: "inspect", tools: [...tools] } as const);
export const indexCommand = { operation: "inspect", detail: "summary" } as const;
/** Keep only the requested tools from an inspection that may have described every tool. */
export const selectTools =
  (tools?: readonly string[]) =>
  <A extends { readonly name: string }>(all: readonly A[]): readonly A[] =>
    tools === undefined ? all : all.filter((tool) => tools.includes(tool.name));

/** Framework-owned dispatch, independent of app-authored HTTP routing. */
export const HostRequest = Schema.Union([
  WorkflowCommand,
  WebhookCommand,
  Schema.Struct({ operation: Schema.Literal("requirements") }),
  Schema.Struct({
    operation: Schema.Literal("inspect"),
    /** Omit schemas. Earlier builds ignore this and return full tools, which hosts reduce. */
    detail: Schema.optionalKey(Schema.Literal("summary")),
    /** Describe only these tools. Earlier builds ignore this and hosts filter the full list. */
    tools: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  }),
  Schema.Struct({ operation: Schema.Literal("skills") }),
  Schema.Struct({
    operation: Schema.Literal("query"),
    name: Schema.NonEmptyString,
    input: JsonValue,
  }),
  Schema.Struct({
    operation: Schema.Literal("mutate"),
    name: Schema.NonEmptyString,
    input: JsonValue,
  }),
  Schema.Struct({
    operation: Schema.Literal("call"),
    tool: Schema.NonEmptyString,
    input: JsonValue,
  }),
]);
/** Parsed portable dispatch request. */
export type HostRequest = typeof HostRequest.Type;

/** The dispatch request did not match the protocol. */
export class HostRequestInvalid extends Schema.TaggedError<HostRequestInvalid>()(
  "HostRequestInvalid",
  {},
) {}
/** Host-supplied accounts did not satisfy the declared slots or native method schemas. */
export class HostAccountsInvalid extends Schema.TaggedError<HostAccountsInvalid>()(
  "HostAccountsInvalid",
  {},
) {}
/** The module or declared capability shape could not be hosted. */
export class HostDeclarationInvalid extends Schema.TaggedError<HostDeclarationInvalid>()(
  "HostDeclarationInvalid",
  {},
) {}
/** Fresh app evaluation failed before calling a tool. */
export class HostEvaluationFailed extends Schema.TaggedError<HostEvaluationFailed>()(
  "HostEvaluationFailed",
  {},
) {}
/** No query or mutation matched the requested name. */
export class HostOperationNotFound extends Schema.TaggedError<HostOperationNotFound>()(
  "HostOperationNotFound",
  {},
) {}
/** An app operation failed. Raw author failures remain private. */
export class HostOperationFailed extends Schema.TaggedError<HostOperationFailed>()(
  "HostOperationFailed",
  {},
) {}
/** The freshly evaluated catalog did not contain the requested tool. */
export class HostToolNotFound extends Schema.TaggedError<HostToolNotFound>()(
  "HostToolNotFound",
  {},
) {}
/** Native input decoding failed; supplied values are omitted. */
export class HostInputInvalid extends Schema.TaggedError<HostInputInvalid>()(
  "HostInputInvalid",
  {},
) {}
/** The tool's approval policy blocked this call before its tool body ran. */
export class HostToolBlocked extends Schema.TaggedError<HostToolBlocked>()("HostToolBlocked", {}) {}
/** Policy elicitation plus decoded input. No tool body ran; the host owns delivery and resumption. */
export class HostToolApprovalRequired extends Schema.TaggedError<HostToolApprovalRequired>()(
  "HostToolApprovalRequired",
  { input: JsonValue, elicitation: ApprovalElicitation },
) {}
/** The tool's approval policy failed or returned an invalid decision. Author failures remain private. */
export class HostToolPolicyFailed extends Schema.TaggedError<HostToolPolicyFailed>()(
  "HostToolPolicyFailed",
  {},
) {}
/** A tool result was not JSON; the result is never included in the error. */
export class HostOutputInvalid extends Schema.TaggedError<HostOutputInvalid>()(
  "HostOutputInvalid",
  {},
) {}

/** Declaration reads do not bind accounts or evaluate the app factory. */
export const HostRequirementsError = Schema.Union([HostRequestInvalid, HostDeclarationInvalid]);
/** Inspection can fail while binding accounts or evaluating the live definition. */
export const HostInspectError = Schema.Union([
  ProviderError,
  SkillLoadFailed,
  HostRequestInvalid,
  HostDeclarationInvalid,
  HostAccountsInvalid,
  HostEvaluationFailed,
]);
/** Tool invocation adds lookup, input, execution and output failures to inspection. */
export const HostCallError = Schema.Union([
  OpenapiResponseError,
  WorkflowFailure,
  HostInspectError,
  HostToolNotFound,
  HostOperationNotFound,
  HostOperationFailed,
  HostInputInvalid,
  HostOutputInvalid,
  HostToolBlocked,
  HostToolApprovalRequired,
  HostToolPolicyFailed,
  ElicitationFailed,
]);
/** Queries, mutations and agent calls use the same operation failures. */
export const HostDataError = HostCallError;

/** Safe error envelope; no author exception, source, account fields or stack is serialized. */
export const HostError = Schema.Union([
  OpenapiResponseError,
  ProviderError,
  SkillLoadFailed,
  WorkflowFailure,
  HostRequestInvalid,
  HostAccountsInvalid,
  HostDeclarationInvalid,
  HostEvaluationFailed,
  HostOperationNotFound,
  HostOperationFailed,
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

/** Invocation-owned outcome sink. Framework adapters report semantic failures
 * independently of successful JSON transport; customer output is never inspected. */
export const ToolResultObservation = Context.Reference<{ readonly failed: () => void }>(
  "apps/ToolResultObservation",
  { defaultValue: () => ({ failed: () => {} }) },
);

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

/** Native handler; context comes from host authority, never from request content. */
export type AppHandler = (request: Request, context: HostContext) => Effect.Effect<Response>;

export { OperationToolPrefixes, type AppOperation, type OperationContext } from "./operations.ts";

export * from "./schedules.ts";
