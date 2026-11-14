/**
 * The JSON-RPC method an MCP POST carries, for the gateway's spans, so MCP latency and failures
 * can be split by method. Every value is from a closed set; nothing the caller chose is recorded.
 */
import type { BrowserMcpToolkit, McpToolkit, NativeMcpToolkit } from "@executor-js/mcp";
import { Option, Schema } from "effect";
import type { McpSchema } from "effect/ai";

/**
 * What 2026-07-28 adds to a client's methods, the events extension's included
 * (`patches/effect-mcp-events.md`). Its adapter's RPC group is internal to Effect, so these are
 * copied from it.
 */
type StatelessClientMethod =
  | "server/discover"
  | "subscriptions/listen"
  | "events/list"
  | "events/subscribe"
  | "events/unsubscribe";
/** Requests and notifications the earlier revisions take from a client, as `McpSchema` types them. */
type ClientMethod =
  | McpSchema.ClientRequestEncoded["method"]
  | McpSchema.ClientNotificationEncoded["method"]
  | StatelessClientMethod;
/**
 * Every method a client can send Executor's MCP server in a revision it serves (`protocols` in
 * `packages/mcp/src/implementation/server.ts`). Any other is `other`, including one only a server
 * sends, such as `sampling/createMessage` or `notifications/subscriptions/acknowledged`. The record
 * type keeps the list equal to `ClientMethod`. It is not read from the protocol adapters at
 * runtime, because that would load them into the API Worker, which runs the gateway.
 */
const methods = new Set(
  Object.keys({
    initialize: true,
    ping: true,
    "server/discover": true,
    "tools/list": true,
    "tools/call": true,
    "resources/list": true,
    "resources/templates/list": true,
    "resources/read": true,
    "resources/subscribe": true,
    "resources/unsubscribe": true,
    "prompts/list": true,
    "prompts/get": true,
    "completion/complete": true,
    "logging/setLevel": true,
    "subscriptions/listen": true,
    "events/list": true,
    "events/subscribe": true,
    "events/unsubscribe": true,
    "notifications/initialized": true,
    "notifications/cancelled": true,
    "notifications/progress": true,
    "notifications/roots/list_changed": true,
  } satisfies Record<ClientMethod, true>),
);

type ExecutorTool =
  | keyof (typeof McpToolkit)["tools"]
  | keyof (typeof NativeMcpToolkit)["tools"]
  | keyof (typeof BrowserMcpToolkit)["tools"];
/** Executor's own MCP tools in every elicitation mode; the record type keeps the list complete. */
const executorTools = new Set(
  Object.keys({
    execute: true,
    call: true,
    search: true,
    describe: true,
    resume: true,
    skills: true,
  } satisfies Record<ExecutorTool, true>),
);

const isRequest = Schema.is(Schema.Struct({ method: Schema.String }));
const isToolCall = Schema.is(Schema.Struct({ params: Schema.Struct({ name: Schema.String }) }));
/** A client's answer to the server's own request, such as an elicitation; it has no method. */
const isResponse = Schema.is(
  Schema.Union([
    Schema.Struct({ result: Schema.Unknown }),
    Schema.Struct({ error: Schema.Unknown }),
  ]),
);

const Json = Schema.fromJsonString(Schema.Unknown);
/** A POST body as JSON. The gateway parses it once, for these attributes and `answerMemoryLimit`. */
export const parseMcpBody = (body: string | undefined): Option.Option<unknown> =>
  body === undefined ? Option.none() : Schema.decodeUnknownOption(Json)(body);

/**
 * `rpc.method`: one of `methods`, `batch` for an array of messages, `response` for a client's answer
 * and `other` for anything else, including a body that is not JSON. A `tools/call` also records
 * `executor.mcp.tool`: the Executor tool it names, or `other`. Arguments are never read.
 */
export const mcpRequestAttributes = (message: Option.Option<unknown>) => {
  const value = Option.getOrUndefined(message);
  const method = Array.isArray(value)
    ? "batch"
    : isRequest(value)
      ? methods.has(value.method)
        ? value.method
        : "other"
      : isResponse(value)
        ? "response"
        : "other";
  const attributes: Record<string, string> = {
    "rpc.system.name": "jsonrpc",
    "rpc.method": method,
  };
  if (method === "tools/call")
    attributes["executor.mcp.tool"] =
      isToolCall(value) && executorTools.has(value.params.name) ? value.params.name : "other";
  return attributes;
};
