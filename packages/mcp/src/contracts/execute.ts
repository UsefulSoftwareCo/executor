/** Execute tool schemas, limits and discovery instructions. */
import { CodeMode } from "@opencode-ai/codemode";
import { Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import { McpSchema, McpServer, Tool as McpTool } from "effect/ai";
import { executionResultContent } from "./media.ts";
import { ApiErrorResponse, ElicitationResponse } from "apps/contracts";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { InteractionId, PendingInteraction, ElicitationResponseInvalid } from "./interactions.ts";
export * from "./interactions.ts";
import { NativeElicitationFailed } from "./elicitation.ts";
import { CallLog, ToolCallReference } from "./call-log.ts";
export * from "./call-log.ts";

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
/** Existing runtime defaults; execution time and call budgets remain in McpLimits. */
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

/** An app requirement has no account the caller linked, so the app exposes no tools. */
export const AppAccountRequired = UserFacingError.define({
  tag: "AppAccountRequired",
  status: 409,
  fields: { app: Schema.String },
  title: "Link an account to continue",
  description: "This app needs an account, and none is linked to it for you.",
  recovery: {
    action: "Open the app's Accounts page and connect or link an account, then run execute again.",
    instructions:
      "Tell the user this app needs an account before its tools can be used. They can connect an account, or link one they already have, on the app's Accounts page. Never substitute another identity automatically. This execution cannot call the app's tools.",
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

/**
 * Executor will not run an approved call, for a reason only its own state establishes. App code
 * asks for approval after it has already run, so the copy says what Executor did with the saved
 * call, never that the tool did not run. A call that ran and failed reports its own error instead.
 */
export const ApprovalUnavailable = UserFacingError.define({
  tag: "ApprovalUnavailable",
  status: 409,
  fields: {
    /**
     * `expired`: the request passed its deadline. `context-changed`: Executor read the app
     * version or accounts and they differ from the reviewed call.
     * `context-unconfirmed`: Executor's storage failed while it read them, so it could not compare.
     * `answered`: another answer already claimed it. `ended`: the execution ended before the
     * request could be saved.
     */
    reason: Schema.Literals([
      "expired",
      "context-changed",
      "context-unconfirmed",
      "answered",
      "ended",
    ]),
  },
  recorded: ({ reason }) => `Approval unavailable: ${reason}`,
  presentation: ({ reason }) => {
    const check =
      "Code that ran before approval was requested, in this tool or earlier in the program, may already have made changes; check current state with a safe read before running anything again.";
    switch (reason) {
      case "expired":
        return {
          title: "Approval expired",
          description:
            "This approval request expired before it was answered, so Executor did not resume the saved call.",
          recovery: {
            action: "Run the call again and ask for approval promptly if it is still wanted.",
            instructions: `Approval requests expire after 15 minutes. ${check} Then start a new execute and ask the user to approve its new request.`,
          },
        };
      case "context-changed":
        return {
          title: "Approved call changed",
          description:
            "The app version or accounts changed after this call was saved for approval, so Executor did not resume it.",
          recovery: {
            action: "Run the call again to review it with the current settings.",
            instructions: `Executor resumes only the exact call that was reviewed, and its settings changed while it waited. ${check} Then start a new execute and ask the user to approve its new request.`,
          },
        };
      case "context-unconfirmed":
        return {
          title: "Approved call not confirmed",
          description:
            "Executor could not read the app version or accounts to confirm they still match the reviewed call, because its own storage failed, so it did not resume the call. Nothing shows that they changed.",
          recovery: {
            action:
              "Try again in a moment: run the call again and approve its new request. If this continues, check Executor's storage.",
            instructions: `This was a failure of Executor's storage, not a change to the call. The approval request is used up, so resuming it again will not run it. ${check} Then start a new execute and ask the user to approve its new request; if storage keeps failing, report it to whoever runs this Executor.`,
          },
        };
      case "answered":
        return {
          title: "Approval already answered",
          description:
            "This approval request was already answered elsewhere, which claimed its saved call, so Executor did not run the call again. That call may still be running, and its outcome is not replayed here.",
          recovery: {
            action:
              "Check the response to the earlier answer, if you have it, and the current state before running anything again.",
            instructions: `Each approval request is answered once. The earlier answer may not have received a result yet, or its response may have been lost. ${check}`,
          },
        };
      case "ended":
        return {
          title: "Execution ended",
          description:
            "The execution ended while this tool was asking for approval, so Executor will not resume the call.",
          recovery: {
            action: "Check current state, then run the program again if it is still needed.",
            instructions: `The execution timed out or was cancelled before the approval request could be saved. ${check}`,
          },
        };
    }
  },
});
export type ApprovalUnavailable = typeof ApprovalUnavailable.Type;

/**
 * Why a resume found no request it could answer. Executor's own record of the request decides it;
 * a request issued to another caller is indistinguishable from an unknown one. `answered`,
 * `expired` and `ended` are recorded ends. `lost`: Executor recorded issuing it to this caller and
 * it is no longer waiting, but no end is recorded. Most often the host holding its program
 * restarted, but a failed write can also leave the end out, so `lost` never shows that the request
 * went unanswered or what its program did. `malformed`: the ID is not in the
 * form Executor issues. `not-found`: Executor keeps no record of it for this caller, which does not
 * show that it was never issued: a record can be missing after a restart, pruning or a storage
 * failure.
 */
export const ResumeUnavailableReason = Schema.Literals([
  "answered",
  "expired",
  "ended",
  "lost",
  "malformed",
  "not-found",
]);
export type ResumeUnavailableReason = typeof ResumeUnavailableReason.Type;
/** The IDs Executor issues: SDK approvals and live tool questions, each a prefix and a UUID. */
export const issuedInteractionId =
  /^(apr|elc)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** The guidance a resume returns with each reason. */
export const resumeUnavailableMessage = (reason: ResumeUnavailableReason): string => {
  const check =
    "Earlier calls in the program, and code a tool ran before asking for approval, may already have made changes: check current state with a safe read before starting a new execute, and never rerun the program automatically.";
  switch (reason) {
    case "answered":
      return `This request was already answered by another resume, which claimed it. Executor does not run it again or replay its outcome here: that program may still be running, and its result goes only to the resume that answered it, if that response arrived. Do not resume it again. ${check}`;
    case "expired":
      return `This request expired before it was answered, so Executor will not resume its program. ${check}`;
    case "ended":
      return `The program that asked this ended before it was answered: it was cancelled, timed out, or stopped. Executor will not resume it. ${check}`;
    case "lost":
      return "Executor recorded issuing this request to this caller, but it is no longer waiting for an answer and Executor has no retained record of an answer or of how it ended, so it cannot continue and resuming again will not help. Most often the Executor host holding its program restarted, which loses the program; a record of how it ended can also be missing when Executor failed to store it. Executor cannot confirm what happened: the request may have been answered, and an earlier approved call, or code a tool ran before asking, may have completed and made changes. Never repeat the call or program automatically. Check current state with a safe read, tell the user what you found, and repeat a call that may change something only if the user explicitly decides to.";
    case "malformed":
      return `This requestId is not one Executor issues: request IDs are apr_ or elc_ followed by a UUID, so it was probably shortened, redacted or mistyped. Resume with the exact requestId from the approval-required or input-required result; pending lists this caller's open requests. ${check}`;
    case "not-found":
      return `Executor has no retained record of this request for this caller, so it cannot say whether it was issued or what became of it. It may belong to another user, grant, scoped connection or approval mode, or the ID may be mistyped. A record can also be missing after Executor restarted, after it pruned old requests, or when its storage was unavailable. pending lists this caller's open requests. In model mode, a new MCP session on the same grant can still answer its requests. ${check}`;
  }
};
/** One of the caller's open requests, listed when a resume names one it cannot answer. */
export const OpenInteraction = Schema.Struct({
  requestId: InteractionId,
  status: Schema.Literals(["approval-required", "input-required"]),
  app: Schema.String,
  tool: Schema.String,
  expiresAt: Schema.Number,
});
export type OpenInteraction = typeof OpenInteraction.Type;
/** Why an issued request stopped being pending without the program losing it. */
export type InteractionEnd = Extract<ResumeUnavailableReason, "answered" | "expired" | "ended">;
/** What a host remembers of a request it issued. */
export interface IssuedInteraction {
  readonly caller: string;
  readonly expiresAt: number;
  readonly end?: InteractionEnd;
}
/**
 * The host's record of the requests it issued, kept beyond its memory. Programs live in memory,
 * so after a restart only this record tells a late resume that its request expired, was answered,
 * or was lost with its program. Calls are synchronous: each is one step that no other request can
 * interleave. A failure to record an issue leaves it unknown (`not-found`), as without a store; a
 * failure to record an end leaves the issue without one (`lost`).
 */
export interface InteractionRecords {
  readonly issued: (id: InteractionId, caller: string, expiresAt: number) => void;
  readonly ended: (id: InteractionId, end: InteractionEnd) => void;
  readonly read: (id: InteractionId) => IssuedInteraction | undefined;
}

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
  /** Only this router's tools are missing; the rest of the app loaded. */
  router: Schema.optionalKey(Schema.String),
});
/**
 * One admitted tool call in call order. `failure` calls threw, or returned a result that says the
 * tool failed, such as a remote MCP tool's `isError: true`; the program received that result
 * whole. A failed call may still have had effects. `interrupted` calls were still running when the
 * execution ended; the upstream may or may not have applied them. `awaiting-approval` calls
 * were still waiting for approval when the execution ended; Executor did not resume the saved
 * call, though the tool may have had effects before it asked.
 */
export const McpToolCall = Schema.Struct({
  name: Schema.String,
  outcome: Schema.Literals(["success", "failure", "interrupted", "awaiting-approval"]),
  durationMs: Schema.optionalKey(Schema.Number),
  /** The host's reference for a call that did not succeed (see `CallLog`). */
  reference: Schema.optionalKey(ToolCallReference),
});
export type McpToolCall = typeof McpToolCall.Type;
/**
 * A failed tool's curated explanation as an agent receives it; a program can read it from a
 * caught tool error. `retryable` means an unchanged repeat may help and is considered safe. It
 * does not guarantee success, and correcting the input, configuration or access may allow a new
 * attempt even when it is false.
 */
/**
 * Which part of Executor's work on an app a failure stopped, as Executor observed it: loading the
 * app's definition (`evaluate`), listing its tools (`discover`) or running one (`call`). Only
 * Executor's own code sets it; a phase the app reports stays in the message as its account.
 */
export const McpFailurePhase = Schema.Literals(["evaluate", "discover", "call"]);
export type McpFailurePhase = typeof McpFailurePhase.Type;
/**
 * The trace ID of the request that met a failure: the one Executor's tracer created, or continued
 * from the MCP client's `traceparent`, never one an app chose. The request's spans and error
 * reports carry it, so a user can share it to find the failure.
 */
export const FailureReference = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u));
export const McpErrorResponse = Schema.Struct({
  ...ApiErrorResponse.fields,
  retryable: Schema.Boolean,
  phase: Schema.optionalKey(McpFailurePhase),
  reference: Schema.optionalKey(FailureReference),
});
export type McpErrorResponse = typeof McpErrorResponse.Type;
/** Program result plus apps that could not expose a live catalog during this execution. */
export const ExecuteResult = Schema.Struct({
  execution: Schema.Union([
    Schema.Struct({ ...CodeMode.Success.fields, toolCalls: Schema.Array(McpToolCall) }),
    Schema.Struct({
      ...CodeMode.Failure.fields,
      error: Schema.Struct({
        kind: CodeMode.Diagnostic.fields.kind,
        message: CodeMode.Diagnostic.fields.message,
        location: CodeMode.Diagnostic.fields.location,
        suggestions: CodeMode.Diagnostic.fields.suggestions,
        response: Schema.optionalKey(McpErrorResponse),
        /** The reference of the tool call whose uncaught failure ended the program. */
        callLog: Schema.optionalKey(CallLog),
      }),
      toolCalls: Schema.Array(McpToolCall),
    }),
  ]),
  unavailableApps: Schema.Array(UnavailableApp),
});
/** MCP execution may return a live pause; completed program results retain the existing fields. */
export const ExecutionOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("completed"), ...ExecuteResult.fields }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    requestId: InteractionId,
    reason: ResumeUnavailableReason,
    message: Schema.String,
    /** The caller's other open requests, which it can still resume. */
    pending: Schema.Array(OpenInteraction),
  }),
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
/**
 * Claude Code saves a text result over 50,000 characters to a file unless the tool raises that
 * threshold. Ask it to show execution results inline up to its 500,000-character ceiling; a larger
 * result still reaches it whole, saved to a file.
 */
export const ExecutionResultMeta = { "anthropic/maxResultSizeChars": 500_000 };

/** Continue an existing program after the agent has obtained the user's decision. Never restarts source. */
export const ResumeTool = McpTool.make("resume", {
  description:
    "Continue a paused execute program using its pending requestId and the user's MCP elicitation response: {action: 'accept', content: {...}}, {action: 'decline'}, or {action: 'cancel'}. Ask the user before approving. Return the user's form fields in content on accept. Returns the next pending interaction or the completed program result. An approved call that fails reports its own error. Unavailable carries a reason (answered, expired, ended, lost, malformed or not-found), what to do and the caller's open requests in pending; do not rerun the whole program because earlier calls may have completed. Busy means another resume is advancing this program; wait for that response. Results are not replayed.",
  dependencies: [HttpServerRequest.HttpServerRequest],
  parameters: ResumeInput,
  success: McpExecutionResult,
  failure: ElicitationResponseInvalid,
})
  .annotate(McpTool.Meta, ExecutionResultMeta)
  .annotate(McpServer.ResultContent, executionResultContent);

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
        "Words matched against tool paths, descriptions, input names, and app, account and router labels. Omit it to list a namespace.",
    }),
  ),
  namespace: Schema.optionalKey(
    Schema.String.annotate({
      description: "App slug, such as axiom, or a namespace inside it, such as acme.issues.",
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
 * A namespace that search items share, listed once per result rather than in every item: an app
 * with its linked accounts, or a titled router inside it.
 */
export const SearchNamespace = Schema.Struct({
  /** The callable prefix of every tool below it, such as tools.axiom. */
  path: Schema.String,
  app: Schema.String,
  /** The linked accounts its calls use per requirement, with IDs, labels and descriptions. */
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
/** One direct tool call: an exact path from search and the tool's JSON input. */
export const CallRequest = Schema.Struct({
  path: Schema.String.annotate({
    description: "An exact path from search, such as tools.github.issues.list.",
  }),
  input: Schema.Json.annotate({ description: "The tool's input, matching its input type." }),
});
/**
 * One call, or several independent calls that run concurrently. The union sits below the top
 * level because several MCP clients reject a tool input schema that is itself a union.
 */
export const CallInput = Schema.Struct({
  calls: Schema.Union([CallRequest, Schema.Array(CallRequest).check(Schema.isMinLength(1))]),
});
/** How one direct call ended. A failed call does not stop the others in its batch. */
export const CallOutcome = Schema.Union([
  Schema.Struct({
    path: Schema.String,
    ok: Schema.Literal(true),
    value: Schema.Json,
    /** Set when the value says the tool failed, such as a remote MCP tool's `isError: true`. */
    callLog: Schema.optionalKey(CallLog),
  }),
  Schema.Struct({
    path: Schema.String,
    ok: Schema.Literal(false),
    error: Schema.Struct({
      kind: CodeMode.DiagnosticKind,
      message: Schema.String,
      response: Schema.optionalKey(McpErrorResponse),
    }),
    /** The closest tool paths, when the path names no tool. */
    matches: Schema.optionalKey(Schema.Array(Schema.String)),
    callLog: Schema.optionalKey(CallLog),
  }),
]);
export type CallOutcome = typeof CallOutcome.Type;
/** Search, describe and call read the catalog directly; a failure here is the caller's whole listing. */
export class CatalogUnavailable extends Schema.TaggedError<CatalogUnavailable>()(
  "CatalogUnavailable",
  { message: Schema.String },
) {}
/**
 * Server-controlled execution budgets; clients cannot override them. Executor sets no limit on the
 * size of a result: `execute` and `call` return the whole value, or fail with the platform's error.
 */
export const McpLimits = Schema.Struct({
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  maxToolCalls: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type McpLimits = typeof McpLimits.Type;
/** Default interpreter budgets; each product may supply different limits. */
export const defaultMcpLimits: McpLimits = {
  timeoutMs: 5 * 60_000,
  maxToolCalls: 100,
};
/** UTF-8 bytes of JSON one search page may hold; `next` continues past it. */
export const searchPageBytes = 25_000;

/** Execute programs over the host-provided app catalog. */
export const ExecuteTool = McpTool.make("execute", {
  description:
    "Run a JavaScript program over Executor apps, for work where one result feeds another call or a large result should be filtered before it reaches you; for one or a few independent calls, use call instead. Find tools with the search tool or tools.search inside the program, and full signatures with describe or tools.search.describe({ paths }). First read the Executor app's entry skill with skills({app:'executor',name:'executor'}). Never ask the user for secrets in chat; accounts connect through Executor's secure links. If approval-required or input-required is returned, show it to the user and call resume with their answer; never run the program's source again. External effects are not rolled back on error or cancellation. Send feedback with the Executor app's feedback.submit tool when Executor gets in your way or something works especially well.",
  dependencies: [HttpServerRequest.HttpServerRequest],
  parameters: ExecuteInput,
  success: McpExecutionResult,
  failure: ExecutionRejected,
})
  .annotate(McpTool.Meta, ExecutionResultMeta)
  .annotate(McpServer.ResultContent, executionResultContent);

/** Native-mode execution obtains policy decisions through server-initiated MCP requests. */
export const NativeExecuteTool = McpTool.make("execute", {
  description:
    "Run a JavaScript program over Executor apps, for work where one result feeds another call or a large result should be filtered before it reaches you; for one or a few independent calls, use call instead. Find tools with the search tool or tools.search inside the program, and full signatures with describe or tools.search.describe({ paths }). First read the Executor app's entry skill with skills({app:'executor',name:'executor'}). Never ask the user for secrets in chat; accounts connect through Executor's secure links. Approvals and tool input open the MCP client's own prompt, and execute continues the same program. Earlier tool calls may already have completed and are not rolled back; never rerun the program automatically after an error. Send feedback with the Executor app's feedback.submit tool when Executor gets in your way or something works especially well.",
  dependencies: [HttpServerRequest.HttpServerRequest, McpSchema.McpRequestContext],
  parameters: ExecuteInput,
  success: McpExecutionResult,
  failure: Schema.Union([NativeElicitationFailed, ElicitationResponseInvalid, ExecutionRejected]),
})
  .annotate(McpTool.Meta, ExecutionResultMeta)
  .annotate(McpServer.ResultContent, executionResultContent);

/** Search reports the apps it could not load beside its matches, as execute results do. */
export const SearchToolResult = Schema.Struct({
  ...SearchResult.fields,
  unavailableApps: Schema.Array(UnavailableApp),
});
/** The catalog search a program reaches as tools.search, as its own MCP tool. */
export const SearchTool = McpTool.make("search", {
  description:
    "Find Executor app tools by words in their paths, descriptions and labels. Returns exact paths, one-line descriptions and input types, with each app and its linked accounts listed once. Pass a path to call or describe, or use it as tools.<path> inside execute. Omit query to list a namespace. To read the following page, call search again with the returned next object as the whole input; next is null on the last page.",
  parameters: SearchInput,
  success: SearchToolResult,
  failure: CatalogUnavailable,
})
  .annotate(McpTool.Readonly, true)
  .annotate(McpTool.Destructive, false);
/** Full signatures for exact paths, as tools.search.describe returns them in a program. */
export const DescribeTool = McpTool.make("describe", {
  description:
    "Read the whole description and TypeScript signature, with input and output types, of tools at exact paths from search. Unknown paths are listed in missing with the closest paths.",
  parameters: DescribeInput,
  success: DescribeResult,
  failure: CatalogUnavailable,
})
  .annotate(McpTool.Readonly, true)
  .annotate(McpTool.Destructive, false);

/** Shared by every delivery mode; each appends how pending interactions are answered. */
export const callDescription =
  "Call Executor app tools directly by exact path from search. Pass one {path, input} as calls, or an array of independent calls to run them concurrently; results come back in the same order, each with ok and its value or error. Use execute instead when one call's output feeds another, or to filter a large result before it reaches you. Never ask the user for secrets in chat; accounts connect through Executor's secure links.";
/** Call tools without a program. Pending interactions return as from execute. */
export const CallTool = McpTool.make("call", {
  description: `${callDescription} If approval-required or input-required is returned, show it to the user and call resume with their answer; never repeat the call to continue it.`,
  dependencies: [HttpServerRequest.HttpServerRequest],
  parameters: CallInput,
  success: McpExecutionResult,
  failure: ExecutionRejected,
})
  .annotate(McpTool.Meta, ExecutionResultMeta)
  .annotate(McpServer.ResultContent, executionResultContent);
/**
 * Native-mode calls. The tool is marked destructive and open-world, so the MCP client confirms each
 * call before it runs; that confirmation answers the apps' approval policies, which are not asked
 * again. Tool input still opens the client's own prompt.
 */
export const NativeCallTool = McpTool.make("call", {
  description: `${callDescription} Your MCP client confirms each call before it runs, so approvals do not ask again. Tool input opens the client's own prompt, and the call continues.`,
  dependencies: [HttpServerRequest.HttpServerRequest, McpSchema.McpRequestContext],
  parameters: CallInput,
  success: McpExecutionResult,
  failure: Schema.Union([NativeElicitationFailed, ElicitationResponseInvalid, ExecutionRejected]),
})
  .annotate(McpTool.Meta, ExecutionResultMeta)
  .annotate(McpServer.ResultContent, executionResultContent)
  .annotate(McpTool.Readonly, false)
  .annotate(McpTool.Destructive, true)
  .annotate(McpTool.OpenWorld, true);
