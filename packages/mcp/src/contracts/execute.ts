/** Execute tool schemas, limits and discovery instructions. */
import { CodeMode } from "@opencode-ai/codemode";
import { Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import { McpSchema, Tool as McpTool } from "effect/ai";
import { ApiErrorResponse, ElicitationResponse } from "apps/contracts";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { InteractionId, PendingInteraction, ElicitationResponseInvalid } from "./interactions.ts";
export * from "./interactions.ts";
import { NativeElicitationFailed } from "./elicitation.ts";

/** Fixed interpreter input, live-program capacity and discovery fan-out and time bounds. */
export const McpRuntimeLimits = Schema.Struct({
  maxCodeChars: Schema.Int.check(Schema.isGreaterThan(0)),
  maxExecutions: Schema.Int.check(Schema.isGreaterThan(0)),
  discoveryConcurrency: Schema.Int.check(Schema.isGreaterThan(0)),
  /** How long discovery waits for the apps a program or search needs before giving up on any. */
  discoveryWaitMs: Schema.Int.check(Schema.isGreaterThan(0)),
  /**
   * After that wait, discovery gives up on the apps still listing once no listing in the
   * execution has completed for this long. Listings share one app runtime, so a slow app is kept
   * while others progress, and a stalled app is dropped soon after the others finish.
   */
  discoveryIdleMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type McpRuntimeLimits = typeof McpRuntimeLimits.Type;
/** Existing runtime defaults; execution time, output and call budgets remain in McpLimits. */
export const defaultMcpRuntimeLimits = McpRuntimeLimits.make({
  maxCodeChars: 65_536,
  maxExecutions: 64,
  discoveryConcurrency: 8,
  // Together well inside the default 5 minute execution budget, which leaves the program time to run.
  discoveryWaitMs: 10_000,
  discoveryIdleMs: 5_000,
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

/**
 * An app was still listing its tools when discovery stopped waiting for it: a large or slow app,
 * or one whose server accepts connections and never answers. A listing that was running keeps
 * running in the background, so a slow but healthy app loads in a later execution.
 */
export const AppDiscoveryTimedOut = UserFacingError.define({
  tag: "AppDiscoveryTimedOut",
  status: 504,
  fields: { app: Schema.String, elapsedMs: Schema.Number },
  recorded: ({ elapsedMs }) => `Listing the app's tools timed out after ${elapsedMs}ms`,
  presentation: ({ elapsedMs }) => ({
    title: "App tools did not load in time",
    description: `Listing this app's tools timed out after ${elapsedMs}ms in this execution, so its tools are unavailable here. A listing that was still running continues in the background, so a slow app usually loads in a later execution. Other apps are not affected.`,
    retryable: true,
    recovery: {
      action:
        "Run execute again shortly. If the app keeps timing out, check that its upstream server responds.",
      instructions:
        "This app's tools were still loading when this execution stopped waiting for them. Retry in a new execute after a few seconds instead of treating the app as broken. If it is still unavailable after several attempts, tell the user its server may be offline or overloaded. Other apps remain usable.",
    },
  }),
});

/** Generated code is bounded before it reaches the parser. */
export const ExecuteInput = Schema.Struct({
  code: Schema.String.check(Schema.isMaxLength(defaultMcpRuntimeLimits.maxCodeChars)),
});
/**
 * Incomplete or failing apps stay visible as explicit discovery diagnostics. Absent fields are
 * omitted: execution results are MCP JSON, which has no undefined.
 */
export const UnavailableApp = Schema.Struct({
  app: Schema.String,
  name: Schema.String,
  reason: Schema.String,
  profile: Schema.optionalKey(Schema.String),
  /** Only this router's tools are missing; the rest of the app loaded. */
  router: Schema.optionalKey(Schema.String),
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

/** Bounds that keep each tools.search item short. Pages are also bounded by bytes. */
export const SearchLimits = Schema.Struct({
  /** Items a page holds when the caller gives no limit. */
  defaultItems: Schema.Int.check(Schema.isGreaterThan(0)),
  /** Characters kept from the first line of a tool's description. */
  descriptionChars: Schema.Int.check(Schema.isGreaterThan(0)),
  /** Characters kept from a tool's single-line input type. A longer type is cut and marked. */
  inputChars: Schema.Int.check(Schema.isGreaterThan(0)),
  /** Paths one tools.search.describe call accepts. */
  describePaths: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type SearchLimits = typeof SearchLimits.Type;
export const defaultSearchLimits = SearchLimits.make({
  defaultItems: 10,
  descriptionChars: 200,
  inputChars: 1_000,
  describePaths: 20,
});

/** Discovery accepts an empty query and supports paging through a large app catalog. */
export const SearchInput = Schema.Struct({
  query: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Words matched against tool paths, descriptions, input names, and app, profile and router labels. Omit it to list a namespace.",
    }),
  ),
  namespace: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "App slug, such as axiom, or a namespace inside it, such as axiom.profiles.ins_id or acme.issues.",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0)).annotate({
      description: `Most items to return, ${defaultSearchLimits.defaultItems} by default. A page ends sooner when it reaches its size budget.`,
    }),
  ),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
/**
 * A namespace that search items share, listed once per result rather than in every item: an app,
 * one of its profiles with its accounts, or a titled router inside either.
 */
export const SearchNamespace = Schema.Struct({
  /** The callable prefix of every tool below it, such as tools.axiom.profiles.ins_id. */
  path: Schema.String,
  app: Schema.String,
  /** The profile's label. Its tools use that profile's saved accounts. */
  profile: Schema.optionalKey(Schema.String),
  /** The profile's account labels, each with its description. */
  accounts: Schema.optionalKey(Schema.String),
  /** The title of the router that groups these tools. */
  router: Schema.optionalKey(Schema.String),
});
export type SearchNamespace = typeof SearchNamespace.Type;
/** One tool, short enough that a page of them fits in an execute result. */
export const SearchItem = Schema.Struct({
  /** The exact callable path. */
  path: Schema.String,
  /** The first line of the tool's description. */
  description: Schema.String,
  /** The input type on one line, without documentation. */
  input: Schema.String,
  /** The input type was cut; tools.search.describe returns it whole. */
  inputTruncated: Schema.optionalKey(Schema.Literal(true)),
  /** The same tool, with the same signature, under the app's other profiles. */
  alsoAt: Schema.optionalKey(Schema.Array(Schema.String)),
});
/**
 * One page of ranked matches. `remaining` counts the matches after this page; `next` is the input
 * for the following page, or null when this page holds the last match.
 */
export const SearchResult = Schema.Struct({
  items: Schema.Array(SearchItem),
  namespaces: Schema.Array(SearchNamespace),
  remaining: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  next: Schema.NullOr(
    Schema.Struct({
      ...SearchInput.fields,
      offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
});
/** Exact paths, as search returns them, whose full detail the caller wants. */
export const DescribeInput = Schema.Struct({
  paths: Schema.Array(Schema.String).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(defaultSearchLimits.describePaths),
  ),
});
/**
 * Full detail for each path found: the whole description and the TypeScript signature with its
 * input and output types. A path that names no tool is in `missing`, with the closest paths.
 */
export const DescribeResult = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ path: Schema.String, description: Schema.String, signature: Schema.String }),
  ),
  namespaces: Schema.Array(SearchNamespace),
  missing: Schema.Array(
    Schema.Struct({ path: Schema.String, matches: Schema.Array(Schema.String) }),
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
  timeoutMs: 5 * 60_000,
  maxToolCalls: 100,
  maxOutputBytes: 65_536,
};
/**
 * UTF-8 bytes of JSON one search page may hold: a quarter of the execute output budget, so a
 * program can return a page beside other data without the result being truncated.
 */
export const searchPageBytes = (limits: McpLimits) => Math.floor(limits.maxOutputBytes / 4);

/** Execute programs over the host-provided app catalog. */
export const ExecuteTool = McpTool.make("execute", {
  description:
    "Run a JavaScript program over Executor apps; find their tools with tools.search inside it and full signatures with tools.search.describe({ paths }). First read the Executor app's executor skill with the skills tool. Never ask the user for secrets in chat; accounts connect through Executor's secure links. If approval-required or input-required is returned, show it to the user and call resume with their answer; never run the program's source again. External effects are not rolled back on error or cancellation. Send feedback with the Executor app's feedback.submit tool when Executor gets in your way or something works especially well.",
  dependencies: [HttpServerRequest.HttpServerRequest],
  parameters: ExecuteInput,
  success: McpExecutionResult,
  failure: ExecutionRejected,
});

/** Native-mode execution obtains policy decisions through server-initiated MCP requests. */
export const NativeExecuteTool = McpTool.make("execute", {
  description:
    "Run a JavaScript program over Executor apps; find their tools with tools.search inside it and full signatures with tools.search.describe({ paths }). First read the Executor app's executor skill with the skills tool. Never ask the user for secrets in chat; accounts connect through Executor's secure links. Approvals and tool input open the MCP client's own prompt, and execute continues the same program. Earlier tool calls may already have completed and are not rolled back; never rerun the program automatically after an error. Send feedback with the Executor app's feedback.submit tool when Executor gets in your way or something works especially well.",
  dependencies: [HttpServerRequest.HttpServerRequest, McpSchema.McpRequestContext],
  parameters: ExecuteInput,
  success: McpExecutionResult,
  failure: Schema.Union([NativeElicitationFailed, ElicitationResponseInvalid, ExecutionRejected]),
});
