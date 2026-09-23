/** A real MCP peer that asks questions inside tools/call. Used by HTTP and legacy SSE checks. */
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ElicitResultSchema,
  type ClientCapabilities,
} from "@modelcontextprotocol/sdk/types.js";

export interface PeerOptions {
  readonly questions?: number;
  readonly stallConnections?: () => boolean;
  readonly onQuestion?: (cancel: () => void) => void;
  readonly hang?: boolean;
  readonly legacyForm?: boolean;
  readonly urlMode?: boolean;
  readonly promptDuringDiscovery?: boolean;
}
export function elicitingServer(
  options: PeerOptions = {},
  record: (event: string) => void = () => {},
) {
  const server = new Server(
    { name: "input-fixture", version: "1" },
    { capabilities: { tools: {} } },
  );
  const capabilities: Array<ClientCapabilities | undefined> = [];
  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    capabilities.push(server.getClientCapabilities());
    record("list");
    if (options.promptDuringDiscovery) {
      try {
        await extra.sendRequest(
          {
            method: "elicitation/create",
            params: {
              mode: "form",
              message: "Discovery must not prompt",
              requestedSchema: { type: "object", properties: {} },
            },
          },
          ElicitResultSchema,
        );
      } catch {
        record("discovery-prompt-rejected");
      }
    }
    return {
      tools: [
        {
          name: "ask",
          description: "Ask during a running upstream call",
          inputSchema: { type: "object", properties: { value: { type: "string" } } },
        },
      ],
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    capabilities.push(server.getClientCapabilities());
    const value = String(request.params.arguments?.value ?? "fixture");
    record(`call:${value}`);
    const marker = crypto.randomUUID();
    const responses = [];
    for (let i = 0; i < (options.questions ?? 2); i++) {
      try {
        const question = new AbortController();
        options.onQuestion?.(() => question.abort());
        const response = await extra.sendRequest(
          {
            method: "elicitation/create",
            params: options.urlMode
              ? {
                  mode: "url",
                  message: "Unsupported URL input",
                  url: "https://example.test/approve",
                  elicitationId: "url-fixture",
                }
              : {
                  ...(options.legacyForm ? {} : { mode: "form" as const }),
                  message: `${value}:${i + 1}`,
                  requestedSchema: {
                    type: "object",
                    properties: { answer: { type: "string", minLength: 1 } },
                    required: ["answer"],
                  },
                  _meta: {
                    origin: "https://fixture.example",
                    persist: ["session", "always"],
                    marker,
                  },
                },
          },
          ElicitResultSchema,
          { timeout: 20_000, signal: question.signal },
        );
        responses.push(response);
        record(`answer:${response.action}`);
        if (response.action !== "accept") break;
      } catch {
        record("input-failed");
        return { isError: true, content: [{ type: "text", text: "Input unavailable" }] };
      }
    }
    if (options.hang)
      await new Promise<void>((resolve) => {
        extra.signal.addEventListener("abort", () => resolve(), { once: true });
        if (extra.signal.aborted) resolve();
      });
    record(`done:${value}`);
    return {
      content: [{ type: "text", text: "Answered" }],
      structuredContent: { marker, value, responses },
    };
  });
  return { server, capabilities };
}

export async function withElicitingMcp(
  options: PeerOptions & { readonly legacy?: boolean },
  run: (peer: {
    url: string;
    events: string[];
    sessions: Map<string, Server>;
    capabilities: Array<ClientCapabilities | undefined>;
  }) => Promise<void>,
) {
  const sessions = new Map<string, Server>();
  const transports = new Map<string, StreamableHTTPServerTransport | SSEServerTransport>();
  const events: string[] = [],
    capabilities: Array<ClientCapabilities | undefined> = [];
  const http = createServer(async (request, response) => {
    try {
      if (options.legacy && request.url === "/mcp" && request.method === "POST") {
        response.writeHead(405).end();
        return;
      }
      const id = options.legacy
        ? new URL(request.url ?? "/", "http://fixture").searchParams.get("sessionId")
        : request.headers["mcp-session-id"];
      if (typeof id === "string") {
        const transport = transports.get(id);
        if (transport === undefined) {
          response.writeHead(404).end();
          return;
        }
        if (transport instanceof SSEServerTransport)
          await transport.handlePostMessage(request, response);
        else await transport.handleRequest(request, response);
        return;
      }
      if (options.stallConnections?.()) return;
      const fixture = elicitingServer(options, (event) => {
        events.push(event);
        if (event === "list" || event.startsWith("call:"))
          capabilities.push(fixture.server.getClientCapabilities());
      });
      const transport = options.legacy
        ? new SSEServerTransport("/messages", response)
        : new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (session) => {
              sessions.set(session, fixture.server);
              transports.set(session, transport);
            },
          });
      // Hide optional SDK getters that conflict with its exact-optional Transport interface.
      const wire:
        | Omit<StreamableHTTPServerTransport, "onclose" | "onerror" | "onmessage" | "sessionId">
        | SSEServerTransport = transport;
      await fixture.server.connect(wire);
      if (transport instanceof SSEServerTransport) {
        sessions.set(transport.sessionId, fixture.server);
        transports.set(transport.sessionId, transport);
        response.on("close", () => {
          sessions.delete(transport.sessionId);
          transports.delete(transport.sessionId);
        });
      } else await transport.handleRequest(request, response);
      const onclose = transport.onclose;
      transport.onclose = () => {
        if (transport.sessionId !== undefined) {
          sessions.delete(transport.sessionId);
          transports.delete(transport.sessionId);
        }
        onclose?.();
      };
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("TCP required");
  try {
    await run({ url: `http://127.0.0.1:${address.port}/mcp`, events, sessions, capabilities });
  } finally {
    await Promise.all([...sessions.values()].map((server) => server.close()));
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
