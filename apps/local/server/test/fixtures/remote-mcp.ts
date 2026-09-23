/** A real HTTP peer with account-dependent, paginated MCP tools. Synthetic credentials only. */
import { createServer, type ServerResponse } from "node:http";
import { Schema } from "effect";
import type { JsonObject } from "apps";

const Message = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
    method: Schema.String,
    params: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  }),
);

export async function withRemoteMcp(
  options: {
    readonly streaming?: boolean;
    readonly legacy?: boolean;
    readonly cursorLoop?: boolean;
    readonly unauthorized?: boolean;
    readonly authChallenge?: string;
    readonly onCall?: () => void;
    readonly onList?: () => void;
    readonly hang?: boolean;
    readonly inputSchema?: JsonObject;
    readonly outputSchema?: JsonObject;
    readonly structuredContent?: JsonObject;
    readonly isError?: boolean;
  },
  run: (peer: { url: string; calls: string[]; sessions: Set<string> }) => Promise<void>,
) {
  const calls: string[] = [];
  const sessions = new Set<string>();
  const streams = new Map<string, ServerResponse>();
  const server = createServer(async (request, response) => {
    const account = request.headers.authorization?.replace("Bearer ", "") ?? "public";
    if (options.legacy && request.url === "/mcp" && request.method === "POST") {
      response.writeHead(405);
      response.end();
      return;
    }
    if (options.unauthorized) {
      response.writeHead(
        401,
        options.authChallenge === undefined ? {} : { "www-authenticate": options.authChallenge },
      );
      response.end("synthetic secret must not escape");
      return;
    }
    if (options.legacy && request.method === "GET") {
      const session = crypto.randomUUID();
      streams.set(session, response);
      sessions.add(session);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`event: endpoint\ndata: /messages?session=${session}\n\n`);
      response.on("close", () => {
        streams.delete(session);
        sessions.delete(session);
      });
      return;
    }
    if (request.method === "GET") {
      response.writeHead(405);
      response.end();
      return;
    }
    if (request.method === "DELETE") {
      sessions.delete(String(request.headers["mcp-session-id"]));
      response.writeHead(204);
      response.end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = Schema.decodeUnknownSync(Message)(body);
    if (message.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    const session = options.legacy
      ? new URL(request.url ?? "/", "http://fixture").searchParams.get("session")
      : message.method === "initialize"
        ? crypto.randomUUID()
        : String(request.headers["mcp-session-id"]);
    if (!session || (message.method !== "initialize" && !sessions.has(session))) {
      response.writeHead(404);
      response.end();
      return;
    }
    sessions.add(session);
    let result: unknown;
    switch (message.method) {
      case "initialize":
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        };
        break;
      case "tools/list":
        options.onList?.();
        result = message.params?.cursor
          ? {
              tools: [{ name: "failure", inputSchema: { type: "object" } }],
              ...(options.cursorLoop ? { nextCursor: "next" } : {}),
            }
          : {
              tools: [
                {
                  name: account,
                  title: "Account tool",
                  description: "Reads the selected account",
                  annotations: { readOnlyHint: true },
                  _meta: { fixture: true },
                  inputSchema: options.inputSchema ?? {
                    $schema: "http://json-schema.org/draft-07/schema#",
                    type: "object",
                    properties: { value: { type: "string" } },
                    required: ["value"],
                  },
                  outputSchema: options.outputSchema ?? {
                    type: "object",
                    properties: { account: { type: "string" } },
                    required: ["account"],
                  },
                },
              ],
              nextCursor: "next",
            };
        break;
      case "tools/call":
        calls.push(`${account}:${message.params?.name}`);
        options.onCall?.();
        if (options.hang) return;
        result =
          message.params?.name === "failure"
            ? { content: [{ type: "text", text: "Could not complete" }], isError: true }
            : {
                content: [{ type: "text", text: account }],
                structuredContent: options.structuredContent ?? { account },
                _meta: { fixture: true },
                ...(options.isError === undefined ? {} : { isError: options.isError }),
              };
        break;
      default:
        result = {};
    }
    const data = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
    if (options.legacy) {
      streams.get(session)?.write(`event: message\ndata: ${data}\n\n`);
      response.writeHead(202);
      response.end();
    } else {
      response.writeHead(200, {
        "content-type": options.streaming ? "text/event-stream" : "application/json",
        "mcp-session-id": session,
      });
      response.end(options.streaming ? `event: message\ndata: ${data}\n\n` : data);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TCP listener required");
  try {
    await run({ url: `http://127.0.0.1:${address.port}/mcp`, calls, sessions });
  } finally {
    for (const stream of streams.values()) stream.end();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
