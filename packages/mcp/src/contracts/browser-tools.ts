/** Browser mode collects decisions through the authenticated browser, never through MCP arguments. */
import { Schema } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { Tool as McpTool } from "effect/unstable/ai";
import { ToolPending } from "@executor-js/sdk/core";
import { ExecuteInput, ExecutionOutcome, ExecutionRejected } from "./execute.ts";
import { ElicitationResponseInvalid, InteractionId, ToolInputPending } from "./interactions.ts";

/** Browser pending results retain the standard interaction and add its authenticated review link. */
export const BrowserExecutionResult = Schema.Union([
  ExecutionOutcome,
  Schema.Struct({ ...ToolPending.fields, approvalUrl: Schema.String }),
  Schema.Struct({ ...ToolInputPending.fields, approvalUrl: Schema.String }),
]);
export type BrowserExecutionResult = typeof BrowserExecutionResult.Type;

/** The agent can collect a browser answer, but cannot supply or replace it. */
export const BrowserResumeInput = Schema.Struct({ requestId: InteractionId });
/** Execute with browser-based delivery of every pending interaction. */
export const BrowserExecuteTool = McpTool.make("execute", {
  description:
    "Run a JavaScript program over Executor apps. Read skills for app authoring and use tools.search to discover callable paths. If approval-required or input-required is returned, show the user approvalUrl and call resume with requestId only. The user answers in their authenticated browser. Never submit the decision yourself or rerun the program to continue it. Earlier effects are not rolled back.",
  dependencies: [HttpServerRequest.HttpServerRequest],
  parameters: ExecuteInput,
  success: BrowserExecutionResult,
  failure: ExecutionRejected,
});
/** Wait for a browser-submitted decision, then continue through the common execution manager. */
export const BrowserResumeTool = McpTool.make("resume", {
  description:
    "Collect the answer submitted through approvalUrl and continue the same program. Pass only requestId. This waits briefly for the browser; if the same pending request returns, wait and call resume again. Show any new approvalUrl to the user. Do not invent a response or rerun execute. Unavailable means expired, consumed or lost; earlier effects may have completed.",
  dependencies: [HttpServerRequest.HttpServerRequest],
  parameters: BrowserResumeInput,
  success: BrowserExecutionResult,
  failure: ElicitationResponseInvalid,
});
