import { Effect, type Cause } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import {
  defaultMcpResource,
  jsonRpcErrorBody,
  mcpResourceKey,
  type McpResource,
} from "@executor-js/host-mcp";
import {
  createExecutorMcpServer,
  type ExecutorMcpServerConfig,
} from "@executor-js/host-mcp/tool-server";
import {
  approvalUrlForRequest,
  decodeResumeResponse,
  formatResumeAcknowledgement,
  readElicitationMode,
} from "@executor-js/host-mcp/browser-approval";
import { makeInProcessBrowserApprovalStore } from "@executor-js/host-mcp/browser-approval-store";
import {
  formatPausedExecution,
  type ExecutionEngine,
  type ResumeResponse,
} from "@executor-js/execution";

import { startIntegrationsRefresh } from "./integrations";

type AnyExecutionEngine = ExecutionEngine<Cause.YieldableError>;

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

export interface LocalMcpServerConfig {
  readonly config: ExecutorMcpServerConfig;
  readonly close?: () => Promise<void>;
}

export interface LocalMcpRequestHandlerConfig {
  readonly defaultConfig: ExecutorMcpServerConfig;
  readonly createConfigForResource?: (
    resource: McpResource,
  ) => Promise<LocalMcpServerConfig> | LocalMcpServerConfig;
}

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

const toolkitPathPattern = /^\/mcp\/toolkits\/([^/?#]+)\/?$/;

const resourceFromRequest = (request: Request): McpResource | null => {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/mcp" || pathname === "/mcp/") return defaultMcpResource;
  const match = toolkitPathPattern.exec(pathname);
  if (!match) return null;
  return { kind: "toolkit", slug: decodeURIComponent(match[1]) };
};

const engineFromConfig = (config: ExecutorMcpServerConfig): AnyExecutionEngine | null =>
  "engine" in config ? config.engine : null;

const normalizeHandlerConfig = (
  input: ExecutorMcpServerConfig | LocalMcpRequestHandlerConfig,
): LocalMcpRequestHandlerConfig => ("defaultConfig" in input ? input : { defaultConfig: input });

export const createMcpRequestHandler = (
  input: ExecutorMcpServerConfig | LocalMcpRequestHandlerConfig,
): McpRequestHandler => {
  const handlerConfig = normalizeHandlerConfig(input);
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();
  const resources = new Map<string, McpResource>();
  const sessionEngines = new Map<string, AnyExecutionEngine>();
  const sessionClosers = new Map<string, () => Promise<void>>();
  const approvals = makeInProcessBrowserApprovalStore();
  const defaultEngine = engineFromConfig(handlerConfig.defaultConfig);

  const pausedDetail = (
    sessionId: string,
    executionId: string,
  ): Promise<ReturnType<typeof formatPausedExecution> | null> =>
    (sessionEngines.get(sessionId) ?? defaultEngine)
      ? Effect.runPromise(
          (sessionEngines.get(sessionId) ?? defaultEngine)!.getPausedExecution(executionId).pipe(
            Effect.map((paused) => (paused ? formatPausedExecution(paused) : null)),
            Effect.orElseSucceed(() => null),
          ),
        )
      : Promise.resolve(null);

  const configForResource = async (resource: McpResource): Promise<LocalMcpServerConfig> => {
    if (!handlerConfig.createConfigForResource) return { config: handlerConfig.defaultConfig };
    return handlerConfig.createConfigForResource(resource);
  };

  const dispose = async (id: string, opts: { transport?: boolean; server?: boolean } = {}) => {
    const t = transports.get(id);
    const s = servers.get(id);
    const close = sessionClosers.get(id);
    transports.delete(id);
    servers.delete(id);
    resources.delete(id);
    sessionEngines.delete(id);
    sessionClosers.delete(id);
    if (opts.transport) await ignoreClose(t ? () => t.close() : undefined);
    if (opts.server) await ignoreClose(s ? () => s.close() : undefined);
    await ignoreClose(close);
  };

  return {
    handleRequest: async (request) => {
      const resource = resourceFromRequest(request);
      if (!resource) return jsonError(404, -32001, "MCP resource not found");
      const sessionId = request.headers.get("mcp-session-id");

      if (sessionId) {
        const transport = transports.get(sessionId);
        if (!transport) return jsonError(404, -32001, "Session not found");
        const sessionResource = resources.get(sessionId);
        if (!sessionResource || mcpResourceKey(sessionResource) !== mcpResourceKey(resource)) {
          return jsonError(403, -32003, "Session belongs to a different MCP resource");
        }
        return transport.handleRequest(request);
      }

      let created: McpServer | undefined;
      let createdSessionId: string | null = null;
      let resourceConfig: LocalMcpServerConfig | null = null;
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          createdSessionId = sid;
          transports.set(sid, transport);
          if (created) servers.set(sid, created);
          resources.set(sid, resource);
          const engine = resourceConfig ? engineFromConfig(resourceConfig.config) : null;
          if (engine) sessionEngines.set(sid, engine);
          if (resourceConfig?.close) sessionClosers.set(sid, resourceConfig.close);
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
        resourceConfig = await configForResource(resource);
        created = await Effect.runPromise(
          createExecutorMcpServer({
            ...resourceConfig.config,
            browserApprovalStore: approvals.store,
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
          await ignoreClose(resourceConfig?.close);
        }
        return response;
      } catch (error) {
        console.error("[mcp] handleRequest error:", formatBoundaryError(error));
        if (!transport.sessionId) {
          await ignoreClose(() => transport.close());
          const server = created;
          await ignoreClose(server ? () => server.close() : undefined);
          await ignoreClose(resourceConfig?.close);
        }
        return jsonError(500, -32603, "Internal server error");
      }
    },

    handlePausedRequest: async (request) => {
      const match = pausedRequestPattern.exec(new URL(request.url).pathname);
      if (!match) return json({ error: "Not found" }, 404);
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

      const paused = await pausedDetail(decodeURIComponent(match[1]), decodeURIComponent(match[2]));
      if (!paused) return json({ error: "Paused execution not found" }, 404);
      return json({ text: paused.text, structured: paused.structured });
    },

    handleApprovalRequest: async (request) => {
      const match = approvalRequestPattern.exec(new URL(request.url).pathname);
      if (!match) return json({ error: "Not found" }, 404);
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

      const sessionId = decodeURIComponent(match[1]);
      const executionId = decodeURIComponent(match[2]);
      // The shared engine must still hold the paused execution — guards stale ids.
      if (!(await pausedDetail(sessionId, executionId))) {
        return json({ error: "MCP session not found" }, 404);
      }

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
