// Fake `codex app-server` fixture for appserver-connector.test.ts, spawned as
// a child process with `bun run <this file>`. Speaks the app-server JSON-RPC
// protocol over newline-delimited stdio with the same shapes the real binary
// uses (verified against codex-rs/app-server-protocol v2), including:
//
//   - handshake ordering: `thread/start` is refused until the `initialized`
//     notification has arrived, so the bridge's sequence is asserted here;
//   - a paginated `mcpServerStatus/list` whose FIRST page holds a different
//     server, so the bridge must follow `nextCursor`;
//   - a `needs_approval` tool that emits a server→client
//     `mcpServer/elicitation/request` and only succeeds when the answer is
//     an accept — the round trip through executor's elicitation bridge.
import * as readline from "node:readline";

import { Option, Schema } from "effect";

const decodeMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
      method: Schema.optional(Schema.String),
      params: Schema.optional(Schema.Unknown),
      result: Schema.optional(Schema.Unknown),
    }),
  ),
);

const decodeInitializeParams = Schema.decodeUnknownOption(
  Schema.Struct({ clientInfo: Schema.Struct({ name: Schema.String }) }),
);

const decodeThreadStartParams = Schema.decodeUnknownOption(
  Schema.Struct({ approvalPolicy: Schema.optional(Schema.String) }),
);

const decodeThreadParams = Schema.decodeUnknownOption(
  Schema.Struct({
    threadId: Schema.optional(Schema.String),
    cursor: Schema.optional(Schema.String),
  }),
);

const decodeToolCallParams = Schema.decodeUnknownOption(
  Schema.Struct({
    threadId: Schema.String,
    server: Schema.String,
    tool: Schema.String,
    arguments: Schema.optional(Schema.Unknown),
  }),
);

const decodeElicitAnswer = Schema.decodeUnknownOption(
  Schema.Struct({ action: Schema.String, content: Schema.optional(Schema.Unknown) }),
);

const THREAD_ID = "thread-fixture-1";

const TOOLS = {
  echo: {
    name: "echo",
    description: "Echo the arguments back",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
  needs_approval: {
    name: "needs_approval",
    description: "Succeeds only after an accepted elicitation",
    inputSchema: { type: "object", properties: {} },
  },
};

const write = (message: object): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const reply = (id: number | string, result: unknown): void => {
  write({ jsonrpc: "2.0", id, result });
};

const replyError = (id: number | string, code: number, message: string): void => {
  write({ jsonrpc: "2.0", id, error: { code, message } });
};

let initializedSeen = false;
let elicitationsAllowed = false;
let nextServerRequestId = 1000;
/** Elicitation request id → the pending tool call's request id. */
const pendingApprovals = new Map<number | string, number | string>();

const serverStatusPage = (cursor: string | undefined): object =>
  cursor === undefined
    ? {
        data: [
          {
            name: "decoy",
            runtimeStatus: "connected",
            pluginId: null,
            serverInfo: null,
            tools: {},
            resources: [],
            resourceTemplates: [],
            authStatus: "unsupported",
          },
        ],
        nextCursor: "page-2",
      }
    : {
        data: [
          {
            name: "messages",
            runtimeStatus: "connected",
            pluginId: "messages",
            serverInfo: null,
            tools: TOOLS,
            resources: [],
            resourceTemplates: [],
            authStatus: "unsupported",
          },
        ],
        nextCursor: null,
      };

const handleToolCall = (id: number | string, params: unknown): void => {
  const decoded = decodeToolCallParams(params);
  if (Option.isNone(decoded)) {
    replyError(id, -32602, "malformed mcpServer/tool/call params");
    return;
  }
  const call = decoded.value;
  if (call.threadId !== THREAD_ID || call.server !== "messages") {
    replyError(id, -32602, `unknown thread or server: ${call.threadId}/${call.server}`);
    return;
  }
  if (call.tool === "echo") {
    reply(id, {
      content: [{ type: "text", text: JSON.stringify(call.arguments ?? {}) }],
      structuredContent: { codexHome: process.env["CODEX_HOME"] ?? null },
      isError: null,
    });
    return;
  }
  if (call.tool === "needs_approval") {
    if (!elicitationsAllowed) {
      // Exactly what Codex returns when it declines the elicitation for the
      // client: an error result, no prompt, no explanation.
      reply(id, {
        content: [{ type: "text", text: "access was not approved" }],
        isError: true,
      });
      return;
    }
    const elicitationId = nextServerRequestId++;
    pendingApprovals.set(elicitationId, id);
    write({
      jsonrpc: "2.0",
      id: elicitationId,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: THREAD_ID,
        turnId: null,
        serverName: "messages",
        mode: "form",
        _meta: null,
        message: "Allow the fixture to proceed?",
        requestedSchema: { type: "object", properties: {} },
      },
    });
    return;
  }
  replyError(id, -32602, `unknown tool: ${call.tool}`);
};

const handleElicitationAnswer = (id: number | string, result: unknown): void => {
  const callId = pendingApprovals.get(id);
  if (callId === undefined) return;
  pendingApprovals.delete(id);
  const answer = Option.getOrUndefined(decodeElicitAnswer(result));
  if (answer?.action === "accept") {
    reply(callId, { content: [{ type: "text", text: "approved" }] });
    return;
  }
  reply(callId, {
    content: [{ type: "text", text: `denied: ${answer?.action ?? "unreadable"}` }],
    isError: true,
  });
};

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const decoded = decodeMessage(line);
  if (Option.isNone(decoded)) return;
  const message = decoded.value;

  if (message.method === undefined) {
    // A response from the bridge — only elicitation answers flow this way.
    if (message.id !== undefined) handleElicitationAnswer(message.id, message.result);
    return;
  }
  if (message.method === "initialized") {
    initializedSeen = true;
    return;
  }
  if (message.id === undefined) return;

  if (message.method === "initialize") {
    const params = decodeInitializeParams(message.params);
    if (Option.isNone(params)) {
      replyError(message.id, -32602, "initialize requires clientInfo");
      return;
    }
    reply(message.id, { userAgent: "codex-fixture/0.0.0" });
    return;
  }
  if (message.method === "thread/start") {
    if (!initializedSeen) {
      replyError(message.id, -32600, "thread/start before the initialized notification");
      return;
    }
    // Codex DECLINES every MCP elicitation itself on a thread whose approval
    // policy does not allow them, so a thread started without one can never
    // receive an approval prompt. The fixture models that: it only elicits
    // when the bridge asked for a policy that permits elicitations.
    const params = Option.getOrUndefined(decodeThreadStartParams(message.params));
    elicitationsAllowed = params?.approvalPolicy === "on-request";
    reply(message.id, { thread: { id: THREAD_ID } });
    return;
  }
  if (message.method === "mcpServerStatus/list") {
    const params = Option.getOrUndefined(decodeThreadParams(message.params));
    if (params?.threadId !== THREAD_ID) {
      replyError(message.id, -32602, "mcpServerStatus/list requires the started threadId");
      return;
    }
    reply(message.id, serverStatusPage(params.cursor));
    return;
  }
  if (message.method === "mcpServer/tool/call") {
    handleToolCall(message.id, message.params);
    return;
  }
  replyError(message.id, -32601, `fixture does not implement ${message.method}`);
});
