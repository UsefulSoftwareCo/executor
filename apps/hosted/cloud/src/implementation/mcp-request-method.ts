import type { BrowserMcpToolkit, McpToolkit, NativeMcpToolkit } from "@executor-js/mcp";
import { Option, Schema } from "effect";
import type { McpSchema } from "effect/ai";

type StatelessClientMethod =
  | "server/discover"
  | "subscriptions/listen"
  | "events/list"
  | "events/subscribe"
  | "events/unsubscribe";
type ClientMethod =
  | McpSchema.ClientRequestEncoded["method"]
  | McpSchema.ClientNotificationEncoded["method"]
  | StatelessClientMethod;
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
const isResponse = Schema.is(
  Schema.Union([
    Schema.Struct({ result: Schema.Unknown }),
    Schema.Struct({ error: Schema.Unknown }),
  ]),
);

const Json = Schema.fromJsonString(Schema.Unknown);
export const parseMcpBody = (body: string | undefined): Option.Option<unknown> =>
  body === undefined ? Option.none() : Schema.decodeUnknownOption(Json)(body);

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
