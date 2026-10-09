/**
 * Host protocol 4: protocol 3 plus call kinds and routers. `call` carries the caller's `kind`, and
 * a bundle refuses a call whose tool has the other kind with `HostKindMismatch`. Inspection
 * answers with a catalog of tools and the routers that group them, instead of a list of tools.
 * Messages it does not change are protocol 3's, taken from its frozen module.
 *
 * Once released, this protocol is frozen like the earlier ones: `bun run check` compares
 * `protocol4` with `packages/apps/protocols/4.json`. The module imports only `effect` and earlier
 * protocol modules, so no change elsewhere can alter it. See notes/apps-publishing.md.
 */
import { Schema } from "effect";
import {
  AppSkillName,
  JsonObject,
  JsonValue,
  McpError,
  OperationSchedule,
  ProviderError,
  SkillLoadFailed,
  ToolAnnotations,
  WebhookCommand,
  WorkflowCommand,
  WorkflowReplay,
  WorkflowRunId,
} from "./1.ts";
import {
  HostDeclarationInvalid,
  HostError as HostErrorV3,
  HostEvaluationFailed,
  InvocationDeadline,
  ResolvedAccounts,
  TrustedToolApproval,
  protocol3,
} from "./3.ts";

export {
  DeclaredAuthMethod,
  DeclaredProvider,
  DeclaredRequirements,
  ResolvedAccount,
  ResolvedAccounts,
  TrustedToolApproval,
  InvocationDeadline,
  SkillSources,
  SkillCatalogResponse,
  HostRequestInvalid,
  HostAccountsInvalid,
  HostDeclarationInvalid,
  HostEvaluationFailed,
  HostOperationNotFound,
  HostOperationFailed,
  HostToolNotFound,
  InputProblem,
  maxInputProblems,
  HostInputInvalid,
  HostToolBlocked,
  HostToolApprovalRequired,
  HostToolPolicyFailed,
  HostOutputInvalid,
} from "./3.ts";

/** An image a client may show beside a router, such as an MCP server's own icon. Models never read it. */
export const RouterIcon = Schema.Struct({
  src: Schema.NonEmptyString,
  mimeType: Schema.optionalKey(Schema.String),
  sizes: Schema.optionalKey(Schema.Array(Schema.String)),
  theme: Schema.optionalKey(Schema.Literals(["light", "dark"])),
});
export type RouterIcon = typeof RouterIcon.Type;

/**
 * Serializable live tool metadata; executable callbacks never cross this boundary. `name` is the
 * tool's full dotted path. `router` is the path of the router that owns it, omitted at the root.
 * `readOnly` marks a query; a tool without it is a mutation.
 */
export const HostedTool = Schema.Struct({
  schedules: Schema.optionalKey(Schema.Array(OperationSchedule)),
  name: Schema.NonEmptyString,
  router: Schema.optionalKey(Schema.NonEmptyString),
  tags: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
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

/** Why one router's tools could not be read. The rest of the app's catalog is unaffected. */
export const HostRouterError = Schema.Union([
  ProviderError,
  McpError,
  SkillLoadFailed,
  HostDeclarationInvalid,
  HostEvaluationFailed,
]);
export type HostRouterError = typeof HostRouterError.Type;

/**
 * One router in a live catalog. `path` is "" for the app's root router. `skill` names the skill
 * that carries this router's instructions. A router with `error` lists none of its tools.
 */
export const HostedRouter = Schema.Struct({
  path: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  icons: Schema.optionalKey(Schema.Array(RouterIcon)),
  tags: Schema.optionalKey(Schema.Record(Schema.NonEmptyString, Schema.String)),
  skill: Schema.optionalKey(AppSkillName),
  error: Schema.optionalKey(HostRouterError),
});
export type HostedRouter = typeof HostedRouter.Type;

/** A live evaluation's tools and the routers that group them. */
export const HostedCatalog = Schema.Struct({
  tools: Schema.Array(HostedTool),
  routers: Schema.Array(HostedRouter),
});
export type HostedCatalog = typeof HostedCatalog.Type;

/** A catalog without tool schemas. Browsing lists these and reads one full tool on selection. */
export const HostedCatalogSummary = Schema.Struct({
  tools: Schema.Array(HostedToolSummary),
  routers: Schema.Array(HostedRouter),
});
export type HostedCatalogSummary = typeof HostedCatalogSummary.Type;

/** Whether a tool reads or writes. */
export const ToolKind = Schema.Literals(["query", "mutation"]);

/** Framework-owned dispatch, independent of app-authored HTTP routing. */
export const HostRequest = Schema.Union([
  WorkflowCommand,
  WebhookCommand,
  Schema.Struct({ operation: Schema.Literal("requirements") }),
  Schema.Struct({
    operation: Schema.Literal("inspect"),
    /** Omit schemas. Only builds that declare the toolIndex capability accept this. */
    detail: Schema.optionalKey(Schema.Literal("summary")),
    /** Describe only these tools. Only builds that declare the toolIndex capability accept this. */
    tools: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
    /**
     * Describe only declared operations that have schedules, without dynamic tool discovery.
     * Only builds that declare the scheduledTools capability accept this.
     */
    scheduled: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.Struct({
    operation: Schema.Literal("skills"),
    /** Answer with SkillSources. Only builds that declare the skillSources capability accept this. */
    sources: Schema.optionalKey(Schema.Literal(true)),
  }),
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
    /**
     * The caller's claim; the bundle rejects a call whose tool has the other kind. The host omits
     * it for a tool its catalog does not list, and then opens storage for writing.
     */
    kind: Schema.optionalKey(ToolKind),
    input: JsonValue,
  }),
]);
/** Parsed portable dispatch request. */
export type HostRequest = typeof HostRequest.Type;

/** The tool exists but is a query called as a mutation, or the reverse. Nothing ran. */
export class HostKindMismatch extends Schema.TaggedError<HostKindMismatch>()("HostKindMismatch", {
  tool: Schema.NonEmptyString,
  requested: ToolKind,
  actual: ToolKind,
}) {}

/**
 * Safe error envelope. Author failures carry only their name and bounded message with account
 * secrets replaced; no source, account fields, stack or cause value is serialized.
 */
export const HostError = Schema.Union([...HostErrorV3.members, HostKindMismatch]);
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

/** The JSON body the host sends to a bundle's generated server entry. */
export const HostInvocation = Schema.Struct({
  command: HostRequest,
  accounts: ResolvedAccounts,
  approval: Schema.optionalKey(TrustedToolApproval),
  replay: Schema.optionalKey(WorkflowReplay),
  deadline: Schema.optionalKey(InvocationDeadline),
  workflowRun: Schema.optionalKey(WorkflowRunId),
});
export type HostInvocation = typeof HostInvocation.Type;

/** Every message of protocol 4, in the order its snapshot records them. */
export const protocol4 = {
  version: 4,
  schemas: {
    invocation: HostInvocation,
    request: HostRequest,
    response: HostResponse,
    requirements: protocol3.schemas.requirements,
    catalog: HostedCatalog,
    catalogSummary: HostedCatalogSummary,
    skills: protocol3.schemas.skills,
    elicitationRequest: protocol3.schemas.elicitationRequest,
    elicitationReply: protocol3.schemas.elicitationReply,
    workflowStep: protocol3.schemas.workflowStep,
    workflowStepReply: protocol3.schemas.workflowStepReply,
    workflowControl: protocol3.schemas.workflowControl,
    cacheCommand: protocol3.schemas.cacheCommand,
    cacheReply: protocol3.schemas.cacheReply,
  },
} as const;
