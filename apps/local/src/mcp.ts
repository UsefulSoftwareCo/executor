import { Effect } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { jsonRpcErrorBody } from "@executor-js/host-mcp";
import {
  createExecutorMcpServer,
  type ExecutorMcpServerConfig,
} from "@executor-js/host-mcp/tool-server";
import {
  approvalUrlForRequest,
  decodeResumeResponse,
  formatResumeAcknowledgement,
  readCodeMode,
  readElicitationMode,
} from "@executor-js/host-mcp/browser-approval";
import { makeInProcessBrowserApprovalStore } from "@executor-js/host-mcp/browser-approval-store";
import { formatPausedExecution, type ResumeResponse } from "@executor-js/execution";

import { startIntegrationsRefresh } from "./integrations";

// ---------------------------------------------------------------------------
// Streamable HTTP handler
// ---------------------------------------------------------------------------

export type McpRequestHandler = {
  readonly handleRequest: (request: Request) => Promise<Response>;
  /** GET `/api/mcp-sessions/:id/executions/:id` — paused detail for the console. */
  readonly handlePausedRequest: (request: Request) => Promise<Response>;
  /** POST `/api/mcp-sessions/:id/executions/:id/resume` — record the decision. */
  readonly handleApprovalRequest: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
};

// Local serves these error bodies in-process; like the self-host store they are
// INNER responses (no CORS) — byte-identical to the prior hand-rolled copy
// (`content-type: application/json` only) via the canonical renderer.
const jsonError = (status: number, code: number, message: string): Response =>
  jsonRpcErrorBody(status, code, message, { cors: false });

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

const pausedRequestPattern = /^\/api\/mcp-sessions\/([^/?#]+)\/executions\/([^/?#]+)$/;
const approvalRequestPattern = /^\/api\/mcp-sessions\/([^/?#]+)\/executions\/([^/?#]+)\/resume$/;

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const readResumeResponse = (request: Request): Promise<ResumeResponse | null> =>
  Effect.runPromise(
    Effect.tryPromise({
      try: () => request.json(),
      catch: () => null,
    }).pipe(Effect.map((raw) => (raw === null ? null : decodeResumeResponse(raw)))),
  );

const resumeApprovalResult = (executionId: string, response: ResumeResponse) => ({
  status: "completed",
  ...formatResumeAcknowledgement(executionId, response),
  isError: false,
});

export const createMcpRequestHandler = (config: ExecutorMcpServerConfig): McpRequestHandler => {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();
  const approvals = makeInProcessBrowserApprovalStore();
  // Local runs one shared engine across every MCP session (main.ts builds it and
  // passes it in), so the paused-execution lookup for browser approval reads it
  // directly — there is no per-session engine to track.
  const engine = "engine" in config ? config.engine : null;

  const pausedDetail = (
    executionId: string,
  ): Promise<ReturnType<typeof formatPausedExecution> | null> =>
    engine
      ? Effect.runPromise(
          engine.getPausedExecution(executionId).pipe(
            Effect.map((paused) => (paused ? formatPausedExecution(paused) : null)),
            Effect.orElseSucceed(() => null),
          ),
        )
      : Promise.resolve(null);

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
      let createdSessionId: string | null = null;
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          createdSessionId = sid;
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
        const elicitationMode = readElicitationMode(request);
        created = await Effect.runPromise(
          createExecutorMcpServer({
            ...config,
            browserApprovalStore: approvals.store,
            codeMode: readCodeMode(request),
            elicitationMode:
              elicitationMode === "browser"
                ? {
                    mode: "browser" as const,
                    approvalUrl: (executionId) =>
                      approvalUrlForRequest(request, executionId, createdSessionId),
                  }
                : { mode: elicitationMode },
          }),
        );
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

    handlePausedRequest: async (request) => {
      const match = pausedRequestPattern.exec(new URL(request.url).pathname);
      if (!match) return json({ error: "Not found" }, 404);
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

      const paused = await pausedDetail(decodeURIComponent(match[2]));
      if (!paused) return json({ error: "Paused execution not found" }, 404);
      return json({ text: paused.text, structured: paused.structured });
    },

    handleApprovalRequest: async (request) => {
      const match = approvalRequestPattern.exec(new URL(request.url).pathname);
      if (!match) return json({ error: "Not found" }, 404);
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

      const executionId = decodeURIComponent(match[2]);
      // The shared engine must still hold the paused execution — guards stale ids.
      if (!(await pausedDetail(executionId))) return json({ error: "MCP session not found" }, 404);

      const response = await readResumeResponse(request);
      if (!response) return json({ error: "Invalid approval response" }, 400);

      await Effect.runPromise(approvals.recordResponse(executionId, response));
      return json(resumeApprovalResult(executionId, response));
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
