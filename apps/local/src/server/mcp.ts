import { Effect } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createExecutorMcpServer, type ExecutorMcpServerConfig } from "@executor-js/host-mcp";

import { startIntegrationsRefresh } from "./integrations";

// ---------------------------------------------------------------------------
// Streamable HTTP handler
// ---------------------------------------------------------------------------

export type McpRequestHandler = {
  readonly handleRequest: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
};

const jsonError = (status: number, code: number, message: string): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json" },
  });

const formatBoundaryError = (error: unknown): unknown => {
  // oxlint-disable-next-line executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: MCP request handler catches unknown SDK/runtime failures for process logging
  if (error instanceof Error) return error.stack ?? error.message;
  return error;
};

const ignoreClose = (close: (() => Promise<void>) | undefined): Promise<void> =>
  close
    ? Effect.runPromise(
        Effect.ignore(
          Effect.tryPromise({
            try: close,
            catch: () => undefined,
          }),
        ),
      )
    : Promise.resolve();

export const createMcpRequestHandler = (config: ExecutorMcpServerConfig): McpRequestHandler => {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();

  const dispose = async (id: string, opts: { transport?: boolean; server?: boolean } = {}) => {
    const t = transports.get(id);
    const s = servers.get(id);
    transports.delete(id);
    servers.delete(id);
    if (opts.transport) await ignoreClose(t ? () => t.close() : undefined);
    if (opts.server) await ignoreClose(s ? () => s.close() : undefined);
  };

  return {
    handleRequest: async (request) => {
      const sessionId = request.headers.get("mcp-session-id");

      if (sessionId) {
        const transport = transports.get(sessionId);
        if (!transport) return jsonError(404, -32001, "Session not found");
        return transport.handleRequest(request);
      }

      let created: McpServer | undefined;
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
          if (created) servers.set(sid, created);
        },
        onsessionclosed: (sid) => void dispose(sid, { server: true }),
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) void dispose(sid, { server: true });
      };

      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: MCP SDK handler must return JSON-RPC errors from thrown Promise APIs
      try {
        created = await Effect.runPromise(createExecutorMcpServer(config));
        await created.connect(transport);
        const response = await transport.handleRequest(request);

        if (!transport.sessionId) {
          await ignoreClose(() => transport.close());
          const server = created;
          await ignoreClose(server ? () => server.close() : undefined);
        }
        return response;
      } catch (error) {
        console.error("[mcp] handleRequest error:", formatBoundaryError(error));
        if (!transport.sessionId) {
          await ignoreClose(() => transport.close());
          const server = created;
          await ignoreClose(server ? () => server.close() : undefined);
        }
        return jsonError(500, -32603, "Internal server error");
      }
    },

    close: async () => {
      const ids = new Set([...transports.keys(), ...servers.keys()]);
      await Promise.all([...ids].map((id) => dispose(id, { transport: true, server: true })));
    },
  };
};

// ---------------------------------------------------------------------------
// Stdio transport
// ---------------------------------------------------------------------------

export const runMcpStdioServer = async (config: ExecutorMcpServerConfig): Promise<void> => {
  startIntegrationsRefresh();

  const server = await Effect.runPromise(createExecutorMcpServer(config));
  const transport = new StdioServerTransport();

  const waitForExit = () =>
    new Promise<void>((resolve) => {
      const finish = () => {
        process.off("SIGINT", finish);
        process.off("SIGTERM", finish);
        process.stdin.off("end", finish);
        process.stdin.off("close", finish);
        resolve();
      };
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
      process.stdin.once("end", finish);
      process.stdin.once("close", finish);
    });

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: stdio server lifetime uses Promise-based SDK/process APIs and always closes resources
  try {
    await server.connect(transport);
    await waitForExit();
  } finally {
    await ignoreClose(() => transport.close());
    await ignoreClose(() => server.close());
  }
};
