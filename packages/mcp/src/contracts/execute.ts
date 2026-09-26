/** Execute tool schemas, limits and discovery instructions. */
import { CodeMode } from "@opencode-ai/codemode";
import { Schema } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { McpSchema, Tool as McpTool } from "effect/unstable/ai";
import { ApiErrorResponse, ElicitationResponse } from "apps/contracts";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { InteractionId, PendingInteraction, ElicitationResponseInvalid } from "./interactions.ts";
export * from "./interactions.ts";
import { NativeElicitationFailed } from "./elicitation.ts";

/** Fixed interpreter input, live-program capacity and discovery fan-out bounds. */
export const McpRuntimeLimits = Schema.Struct({
  maxCodeChars: Schema.Int.check(Schema.isGreaterThan(0)),
  maxExecutions: Schema.Int.check(Schema.isGreaterThan(0)),
  discoveryConcurrency: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type McpRuntimeLimits = typeof McpRuntimeLimits.Type;
/** Existing runtime defaults; execution time, output and call budgets remain in McpLimits. */
export const defaultMcpRuntimeLimits = McpRuntimeLimits.make({
  maxCodeChars: 65_536,
  maxExecutions: 64,
  discoveryConcurrency: 8,
});

/** A product denied admission before a program started. The message is safe for the caller. */
export class ExecutionRejected extends Schema.TaggedError<ExecutionRejected>()(
  "ExecutionRejected",
  { message: Schema.String },
) {}

/**
 * An app that needs accounts exposes no tools until the caller has an enabled profile for it.
 * The caller may have no profile, or only disabled or removed ones.
 */
export const AppProfileRequired = UserFacingError.define({
  tag: "AppProfileRequired",
  status: 409,
  fields: { app: Schema.String },
  title: "Set up an account profile to continue",
  description: "This app needs an account, and you have no enabled profile for it.",
  recovery: {
    action:
      "Open the app's Accounts page and connect an account or enable an existing profile, then run execute again.",
    instructions:
      "Tell the user this app needs an account profile before its tools can be used. They can connect an account, or enable a profile they already have, on the app's Accounts page. Never substitute another identity automatically. This execution cannot call the app's tools.",
  },
});

/** Generated code is bounded before it reaches the parser. */
export const ExecuteInput = Schema.Struct({
  code: Schema.String.check(Schema.isMaxLength(defaultMcpRuntimeLimits.maxCodeChars)),
});
/** Incomplete or failing apps stay visible as explicit discovery diagnostics. */
export const UnavailableApp = Schema.Struct({
  app: Schema.String,
  name: Schema.String,
  reason: Schema.String,
  profile: Schema.optional(Schema.String),
});
/**
 * One admitted tool call in call order. `interrupted` calls were still running when the
 * execution ended; the upstream may or may not have applied them. `awaiting-approval` calls
 * were still waiting for approval when the execution ended; they never ran.
 */
export const McpToolCall = Schema.Struct({
  name: Schema.String,
  outcome: Schema.Literals(["success", "failure", "interrupted", "awaiting-approval"]),
  durationMs: Schema.optionalKey(Schema.Number),
});
export type McpToolCall = typeof McpToolCall.Type;
/** Program result plus apps that could not expose a live catalog during this execution. */
export const ExecuteResult = Schema.Struct({
  execution: Schema.Union([
    Schema.Struct({ ...CodeMode.Success.fields, toolCalls: Schema.Array(McpToolCall) }),
    Schema.Struct({
      ...CodeMode.Failure.fields,
      error: Schema.Struct({
        ...CodeMode.Diagnostic.fields,
        response: Schema.optionalKey(ApiErrorResponse),
      }),
      toolCalls: Schema.Array(McpToolCall),
    }),
  ]),
  unavailableApps: Schema.Array(UnavailableApp),
});
/** MCP execution may return a live pause; completed program results retain the existing fields. */
export const ExecutionOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("completed"), ...ExecuteResult.fields }),
  Schema.Struct({ status: Schema.Literal("unavailable"), requestId: InteractionId }),
  Schema.Struct({ status: Schema.Literal("busy"), requestId: InteractionId }),
  Schema.Struct({ status: Schema.Literal("capacity-exceeded") }),
]);
/** Completed or pending outcomes share one contract in model and native delivery. */
export const McpExecutionResult = Schema.Union([ExecutionOutcome, PendingInteraction]);
export type McpExecutionResult = typeof McpExecutionResult.Type;
/** MCP elicitation responses delivered by the agent; this does not send native or browser prompts. */
export const ResumeInput = Schema.Struct({
  requestId: InteractionId,
  response: ElicitationResponse,
});
/** Continue an existing program after the agent has obtained the user's decision. Never restarts source. */
export const ResumeTool = McpTool.make("resume", {
  description:
    "Continue a paused execute program using its pending requestId and the user's MCP elicitation response: {action: 'accept', content: {...}}, {action: 'decline'}, or {action: 'cancel'}. Ask the user before approving. Return the user's form fields in content on accept. Returns the next pending interaction or the completed program result. An unavailable continuation may have expired, been consumed, or been lost on restart; do not rerun the whole program because earlier calls may have completed. Busy means another resume is advancing this program; wait for that response. Results are not replayed.",
  dependencies: [HttpServerRequest.HttpServerRequest],
  parameters: ResumeInput,
  success: McpExecutionResult,
  failure: ElicitationResponseInvalid,
});

/** Discovery accepts an empty query and supports paging through a large app catalog. */
export const SearchInput = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
  namespace: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "App slug, such as axiom, or a target namespace such as axiom.profiles.ins_id.queries.",
    }),
  ),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
/** Exact callable paths plus a continuation offset, preserving the original tools.search contract. */
export const SearchResult = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ path: Schema.String, description: Schema.String, signature: Schema.String }),
  ),
  remaining: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  next: Schema.NullOr(
    Schema.Struct({ offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
  ),
});
/** Server-controlled execution budgets; clients cannot override them. */
export const McpLimits = Schema.Struct({
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  maxToolCalls: Schema.Int.check(Schema.isGreaterThan(0)),
  maxOutputBytes: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type McpLimits = typeof McpLimits.Type;
/** Default interpreter budgets; each product may supply different limits. */
export const defaultMcpLimits: McpLimits = {
  timeoutMs: 30_000,
  maxToolCalls: 100,
  maxOutputBytes: 65_536,
};

/** Execute programs over the host-provided app catalog. */
export const ExecuteTool = McpTool.make("execute", {
  description:
    "Run a JavaScript program over Executor apps. Discover and read the Executor app's app-authoring skill through the skills tool before creating apps. Start with return await tools.search({query: 'Executor'}). Search returns exact callable paths and TypeScript signatures. Each configured app has its own app-slug namespace and saved accounts. Discover again in a new execute after configuration changes. Use await, Promise.all and return only needed data. For user credentials, discover Executor's account connection tool (mutations.accountConnect_issue locally, mutations.accounts_connect on hosted) and give the user its browser link; never ask for secrets in chat or search their files for tokens. No imports, fetch, process or filesystem globals. Failed/incomplete apps are reported in unavailableApps. If approval-required or input-required is returned, show the elicitation to the user, collect its requested fields, then call resume with the returned requestId and response.action (accept, decline, or cancel). The program waits in memory; do not execute its source again. External effects are not rolled back on error or cancellation.",
  dependencies: [HttpServerRequest.HttpServerRequest],
  parameters: ExecuteInput,
  success: McpExecutionResult,
  failure: ExecutionRejected,
});

/** Native-mode execution obtains policy decisions through server-initiated MCP requests. */
export const NativeExecuteTool = McpTool.make("execute", {
  description:
    "Run a JavaScript program over Executor apps. Discover and read the Executor app's app-authoring skill through the skills tool before creating apps. Use tools.search to discover callable paths. Tool approvals and tool input open the MCP client's native prompt; execute waits for the response and continues the same program. No separate resume call is needed. Decline or cancel fails a policy-guarded call; a running tool receives the action and decides how to handle it. Earlier tool calls may already have completed; never rerun the program automatically after an error.",
  dependencies: [HttpServerRequest.HttpServerRequest, McpSchema.McpRequestContext],
  parameters: ExecuteInput,
  success: McpExecutionResult,
  failure: Schema.Union([NativeElicitationFailed, ElicitationResponseInvalid, ExecutionRejected]),
});
