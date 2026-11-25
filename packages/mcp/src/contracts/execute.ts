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

export const McpRuntimeLimits = Schema.Struct({
  maxCodeChars: Schema.Int.check(Schema.isGreaterThan(0)),
  maxExecutions: Schema.Int.check(Schema.isGreaterThan(0)),
  discoveryConcurrency: Schema.Int.check(Schema.isGreaterThan(0)),
  discoveryWaitMs: Schema.Int.check(Schema.isGreaterThan(0)),
  discoveryIdleMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type McpRuntimeLimits = typeof McpRuntimeLimits.Type;
export const defaultMcpRuntimeLimits = McpRuntimeLimits.make({
  maxCodeChars: 65_536,
  maxExecutions: 64,
  discoveryConcurrency: 8,
  discoveryWaitMs: 10_000,
  discoveryIdleMs: 5_000,
});

export class ExecutionRejected extends Schema.TaggedError<ExecutionRejected>()(
  "ExecutionRejected",
  { message: Schema.String },
) {}

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

export const ApprovalUnavailable = UserFacingError.define({
  tag: "ApprovalUnavailable",
  status: 409,
  fields: {
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

export const ResumeUnavailableReason = Schema.Literals([
  "answered",
  "expired",
  "ended",
  "lost",
  "malformed",
  "not-found",
]);
export type ResumeUnavailableReason = typeof ResumeUnavailableReason.Type;
export const issuedInteractionId =
  /^(apr|elc)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
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
export const OpenInteraction = Schema.Struct({
  requestId: InteractionId,
  status: Schema.Literals(["approval-required", "input-required"]),
  app: Schema.String,
  tool: Schema.String,
  expiresAt: Schema.Number,
});
export type OpenInteraction = typeof OpenInteraction.Type;
export type InteractionEnd = Extract<ResumeUnavailableReason, "answered" | "expired" | "ended">;
export interface IssuedInteraction {
  readonly caller: string;
  readonly expiresAt: number;
  readonly end?: InteractionEnd;
}
export interface InteractionRecords {
  readonly issued: (id: InteractionId, caller: string, expiresAt: number) => void;
  readonly ended: (id: InteractionId, end: InteractionEnd) => void;
  readonly read: (id: InteractionId) => IssuedInteraction | undefined;
}

export const ExecuteInput = Schema.Struct({
  code: Schema.String.check(Schema.isMaxLength(defaultMcpRuntimeLimits.maxCodeChars)),
});
export const UnavailableApp = Schema.Struct({
  app: Schema.String,
  name: Schema.String,
  reason: Schema.String,
  router: Schema.optionalKey(Schema.String),
});
export const McpToolCall = Schema.Struct({
  name: Schema.String,
  outcome: Schema.Literals(["success", "failure", "interrupted", "awaiting-approval"]),
  durationMs: Schema.optionalKey(Schema.Number),
  reference: Schema.optionalKey(ToolCallReference),
});
export type McpToolCall = typeof McpToolCall.Type;
export const McpFailurePhase = Schema.Literals(["evaluate", "discover", "call"]);
export type McpFailurePhase = typeof McpFailurePhase.Type;
export const FailureReference = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u));
export const McpErrorResponse = Schema.Struct({
  ...ApiErrorResponse.fields,
  retryable: Schema.Boolean,
  phase: Schema.optionalKey(McpFailurePhase),
  reference: Schema.optionalKey(FailureReference),
});
export type McpErrorResponse = typeof McpErrorResponse.Type;
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
        callLog: Schema.optionalKey(CallLog),
      }),
      toolCalls: Schema.Array(McpToolCall),
    }),
  ]),
  unavailableApps: Schema.Array(UnavailableApp),
});
export const ExecutionOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("completed"), ...ExecuteResult.fields }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    requestId: InteractionId,
    reason: ResumeUnavailableReason,
    message: Schema.String,
    pending: Schema.Array(OpenInteraction),
  }),
  Schema.Struct({ status: Schema.Literal("busy"), requestId: InteractionId }),
  Schema.Struct({ status: Schema.Literal("capacity-exceeded") }),
]);
export const McpExecutionResult = Schema.Union([ExecutionOutcome, PendingInteraction]);
export type McpExecutionResult = typeof McpExecutionResult.Type;
export const ResumeInput = Schema.Struct({
  requestId: InteractionId,
  response: ElicitationResponse,
});
export const ExecutionResultMeta = { "anthropic/maxResultSizeChars": 500_000 };

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

export const SearchLimits = Schema.Struct({
  defaultItems: Schema.Int.check(Schema.isGreaterThan(0)),
  descriptionChars: Schema.Int.check(Schema.isGreaterThan(0)),
  inputChars: Schema.Int.check(Schema.isGreaterThan(0)),
  describePaths: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type SearchLimits = typeof SearchLimits.Type;
export const defaultSearchLimits = SearchLimits.make({
  defaultItems: 10,
  descriptionChars: 200,
  inputChars: 1_000,
  describePaths: 20,
});

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
export const SearchNamespace = Schema.Struct({
  path: Schema.String,
  app: Schema.String,
  accounts: Schema.optionalKey(Schema.String),
  router: Schema.optionalKey(Schema.String),
});
export type SearchNamespace = typeof SearchNamespace.Type;
export const SearchItem = Schema.Struct({
  path: Schema.String,
  description: Schema.String,
  input: Schema.String,
  inputTruncated: Schema.optionalKey(Schema.Literal(true)),
});
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
export const DescribeInput = Schema.Struct({
  paths: Schema.Array(Schema.String).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(defaultSearchLimits.describePaths),
  ),
});
export const DescribeResult = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ path: Schema.String, description: Schema.String, signature: Schema.String }),
  ),
  namespaces: Schema.Array(SearchNamespace),
  missing: Schema.Array(
    Schema.Struct({ path: Schema.String, matches: Schema.Array(Schema.String) }),
  ),
});
export const CallRequest = Schema.Struct({
  path: Schema.String.annotate({
    description: "An exact path from search, such as tools.github.issues.list.",
  }),
  input: Schema.Json.annotate({ description: "The tool's input, matching its input type." }),
});
export const CallInput = Schema.Struct({
  calls: Schema.Union([CallRequest, Schema.Array(CallRequest).check(Schema.isMinLength(1))]),
});
export const CallOutcome = Schema.Union([
  Schema.Struct({
    path: Schema.String,
    ok: Schema.Literal(true),
    value: Schema.Json,
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
    matches: Schema.optionalKey(Schema.Array(Schema.String)),
    callLog: Schema.optionalKey(CallLog),
  }),
]);
export type CallOutcome = typeof CallOutcome.Type;
export class CatalogUnavailable extends Schema.TaggedError<CatalogUnavailable>()(
  "CatalogUnavailable",
  { message: Schema.String },
) {}
export const McpLimits = Schema.Struct({
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  maxToolCalls: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type McpLimits = typeof McpLimits.Type;
export const defaultMcpLimits: McpLimits = {
  timeoutMs: 5 * 60_000,
  maxToolCalls: 100,
};
export const searchPageBytes = 25_000;

export const ExecuteTool = McpTool.make("execute", {
  description:
    "Run a JavaScript program over Executor apps, for work where one result feeds another call or a large result should be filtered before it reaches you; for one or a few independent calls, use call instead. Find tools with the search tool or tools.search inside the program, and full signatures with describe or tools.search.describe({ paths }). The server instructions are the Executor app's entry skill; if your client did not show them, read it with skills({app:'executor',name:'executor'}). Never ask the user for secrets in chat; accounts connect through Executor's secure links. If approval-required or input-required is returned, show it to the user and call resume with their answer; never run the program's source again. External effects are not rolled back on error or cancellation. Send feedback with the Executor app's feedback.submit tool when Executor gets in your way or something works especially well.",
  dependencies: [HttpServerRequest.HttpServerRequest],
  parameters: ExecuteInput,
  success: McpExecutionResult,
  failure: ExecutionRejected,
})
  .annotate(McpTool.Meta, ExecutionResultMeta)
  .annotate(McpServer.ResultContent, executionResultContent);

export const NativeExecuteTool = McpTool.make("execute", {
  description:
    "Run a JavaScript program over Executor apps, for work where one result feeds another call or a large result should be filtered before it reaches you; for one or a few independent calls, use call instead. Find tools with the search tool or tools.search inside the program, and full signatures with describe or tools.search.describe({ paths }). The server instructions are the Executor app's entry skill; if your client did not show them, read it with skills({app:'executor',name:'executor'}). Never ask the user for secrets in chat; accounts connect through Executor's secure links. Approvals and tool input open the MCP client's own prompt, and execute continues the same program. Earlier tool calls may already have completed and are not rolled back; never rerun the program automatically after an error. Send feedback with the Executor app's feedback.submit tool when Executor gets in your way or something works especially well.",
  dependencies: [HttpServerRequest.HttpServerRequest, McpSchema.McpRequestContext],
  parameters: ExecuteInput,
  success: McpExecutionResult,
  failure: Schema.Union([NativeElicitationFailed, ElicitationResponseInvalid, ExecutionRejected]),
})
  .annotate(McpTool.Meta, ExecutionResultMeta)
  .annotate(McpServer.ResultContent, executionResultContent);

export const SearchToolResult = Schema.Struct({
  ...SearchResult.fields,
  unavailableApps: Schema.Array(UnavailableApp),
});
export const SearchTool = McpTool.make("search", {
  description:
    "Find Executor app tools by words in their paths, descriptions and labels. Returns exact paths, one-line descriptions and input types, with each app and its linked accounts listed once. Pass a path to call or describe, or use it as tools.<path> inside execute. Omit query to list a namespace. To read the following page, call search again with the returned next object as the whole input; next is null on the last page.",
  parameters: SearchInput,
  success: SearchToolResult,
  failure: CatalogUnavailable,
})
  .annotate(McpTool.Readonly, true)
  .annotate(McpTool.Destructive, false);
export const DescribeTool = McpTool.make("describe", {
  description:
    "Read the whole description and TypeScript signature, with input and output types, of tools at exact paths from search. Unknown paths are listed in missing with the closest paths.",
  parameters: DescribeInput,
  success: DescribeResult,
  failure: CatalogUnavailable,
})
  .annotate(McpTool.Readonly, true)
  .annotate(McpTool.Destructive, false);

export const callDescription =
  "Call Executor app tools directly by exact path from search. Pass one {path, input} as calls, or an array of independent calls to run them concurrently; results come back in the same order, each with ok and its value or error. Use execute instead when one call's output feeds another, or to filter a large result before it reaches you. Never ask the user for secrets in chat; accounts connect through Executor's secure links.";
export const CallTool = McpTool.make("call", {
  description: `${callDescription} If approval-required or input-required is returned, show it to the user and call resume with their answer; never repeat the call to continue it.`,
  dependencies: [HttpServerRequest.HttpServerRequest],
  parameters: CallInput,
  success: McpExecutionResult,
  failure: ExecutionRejected,
})
  .annotate(McpTool.Meta, ExecutionResultMeta)
  .annotate(McpServer.ResultContent, executionResultContent);
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
