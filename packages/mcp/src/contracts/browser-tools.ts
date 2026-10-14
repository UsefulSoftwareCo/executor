/** Browser mode collects decisions through the authenticated browser, never through MCP arguments. */
import { Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import { Tool as McpTool } from "effect/ai";
import { ToolPending } from "@executor-js/sdk/core";
import {
  callDescription,
  CallInput,
  ExecuteInput,
  ExecutionOutcome,
  ExecutionRejected,
  ExecutionResultMeta,
} from "./execute.ts";
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
    "Run a JavaScript program over Executor apps, for work where one result feeds another call or a large result should be filtered before it reaches you; for one or a few independent calls, use call instead. Find tools with the search tool or tools.search inside the program, and full signatures with describe or tools.search.describe({ paths }). First read the Executor app's executor skill with the skills tool. Never ask the user for secrets in chat; accounts connect through Executor's secure links. If approval-required or input-required is returned, show the user approvalUrl and call resume with requestId only; the user answers in their browser. Never submit the decision yourself or rerun the program to continue it. Earlier effects are not rolled back. Send feedback with the Executor app's feedback.submit tool when Executor gets in your way or something works especially well.",
  dependencies: [HttpServerRequest.HttpServerRequest],
  parameters: ExecuteInput,
  success: BrowserExecutionResult,
  failure: ExecutionRejected,
}).annotate(McpTool.Meta, ExecutionResultMeta);
/** Direct calls with browser-based delivery of every pending interaction. */
export const BrowserCallTool = McpTool.make("call", {
  description: `${callDescription} If approval-required or input-required is returned, show the user approvalUrl and call resume with requestId only; the user answers in their browser. Never submit the decision yourself or repeat the call to continue it.`,
  dependencies: [HttpServerRequest.HttpServerRequest],
  parameters: CallInput,
  success: BrowserExecutionResult,
  failure: ExecutionRejected,
}).annotate(McpTool.Meta, ExecutionResultMeta);
/** Wait for a browser-submitted decision, then continue through the common execution manager. */
export const BrowserResumeTool = McpTool.make("resume", {
  description:
    "Collect the answer submitted through approvalUrl and continue the same program. Pass only requestId. This waits briefly for the browser; if the same pending request returns, wait and call resume again. Show any new approvalUrl to the user. Do not invent a response or rerun execute. Unavailable means expired, consumed or lost; earlier effects may have completed.",
  dependencies: [HttpServerRequest.HttpServerRequest],
  parameters: BrowserResumeInput,
  success: BrowserExecutionResult,
  failure: ElicitationResponseInvalid,
}).annotate(McpTool.Meta, ExecutionResultMeta);
