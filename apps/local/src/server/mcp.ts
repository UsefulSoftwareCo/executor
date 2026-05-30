import { Deferred, Effect, Option, Schema } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { jsonRpcErrorBody } from "@executor-js/host-mcp";
import {
  createExecutorMcpServer,
  type ExecutorMcpServerConfig,
} from "@executor-js/host-mcp/tool-server";
import type { ResumeResponse } from "@executor-js/execution";

import { startIntegrationsRefresh } from "./integrations";

// ---------------------------------------------------------------------------
// Streamable HTTP handler
// ---------------------------------------------------------------------------

export type McpRequestHandler = {
  readonly handleRequest: (request: Request) => Promise<Response>;
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

type McpElicitationMode = "browser" | "model" | "native";

const MCP_ELICITATION_MODES = new Set<McpElicitationMode>(["browser", "model", "native"]);
const ResumeResponsePayload = Schema.Struct({
  action: Schema.Literals(["accept", "decline", "cancel"]),
  content: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeResumeResponsePayload = Schema.decodeUnknownOption(ResumeResponsePayload);

const readElicitationMode = (request: Request): McpElicitationMode => {
  const url = new URL(request.url);
  const mode = url.searchParams.get("elicitation_mode");
  if (mode && MCP_ELICITATION_MODES.has(mode as McpElicitationMode)) {
    return mode as McpElicitationMode;
  }

  return "model";
};

const approvalUrlForRequest = (
  request: Request,
  executionId: string,
  sessionId: string | null,
): string => {
  const url = new URL(`/resume/${encodeURIComponent(executionId)}`, request.url);
  if (sessionId) url.searchParams.set("mcp_session_id", sessionId);
  return url.toString();
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
    }).pipe(
      Effect.map((raw) =>
        raw === null ? null : Option.getOrNull(decodeResumeResponsePayload(raw)),
      ),
    ),
  );

const resumeApprovalResult = (executionId: string, response: ResumeResponse) => {
  const textByAction = {
    accept: "I've approved it",
    decline: "I've denied it",
    cancel: "I've canceled it",
  } satisfies Record<ResumeResponse["action"], string>;
  const statusByAction = {
    accept: "approved",
    decline: "denied",
    cancel: "canceled",
  } satisfies Record<ResumeResponse["action"], string>;

  return {
    status: "completed",
    text: textByAction[response.action],
    structured: { status: statusByAction[response.action], executionId },
    isError: false,
  };
};

export const createMcpRequestHandler = (config: ExecutorMcpServerConfig): McpRequestHandler => {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();
  const approvalResponses = new Map<string, Map<string, ResumeResponse>>();
  const approvalWaiters = new Map<string, Map<string, Deferred.Deferred<ResumeResponse>>>();

  const dispose = async (id: string, opts: { transport?: boolean; server?: boolean } = {}) => {
    const t = transports.get(id);
    const s = servers.get(id);
    transports.delete(id);
    servers.delete(id);
    approvalResponses.delete(id);
    approvalWaiters.delete(id);
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
            browserApprovalStore: {
              takeResponse: (executionId) =>
                Effect.sync(() => {
                  if (!createdSessionId) return null;
                  const sessionApprovals = approvalResponses.get(createdSessionId);
                  const response = sessionApprovals?.get(executionId) ?? null;
                  sessionApprovals?.delete(executionId);
                  return response;
                }),
              waitForResponse: (executionId) =>
                Effect.gen(function* () {
                  if (!createdSessionId) return null;
                  const sessionApprovals = approvalResponses.get(createdSessionId);
                  const response = sessionApprovals?.get(executionId) ?? null;
                  if (response) {
                    sessionApprovals?.delete(executionId);
                    return response;
                  }

                  const sessionWaiters =
                    approvalWaiters.get(createdSessionId) ??
                    new Map<string, Deferred.Deferred<ResumeResponse>>();
                  const waiter =
                    sessionWaiters.get(executionId) ?? (yield* Deferred.make<ResumeResponse>());
                  sessionWaiters.set(executionId, waiter);
                  approvalWaiters.set(createdSessionId, sessionWaiters);

                  yield* Deferred.await(waiter).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        if (sessionWaiters.get(executionId) === waiter) {
                          sessionWaiters.delete(executionId);
                        }
                      }),
                    ),
                  );
                  const approvals = approvalResponses.get(createdSessionId);
                  const approved = approvals?.get(executionId) ?? null;
                  approvals?.delete(executionId);
                  return approved;
                }),
            },
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

    handleApprovalRequest: async (request) => {
      const url = new URL(request.url);
      const match = approvalRequestPattern.exec(url.pathname);
      if (!match) return json({ error: "Not found" }, 404);
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

      const sessionId = decodeURIComponent(match[1]);
      const executionId = decodeURIComponent(match[2]);
      if (!servers.has(sessionId)) return json({ error: "MCP session not found" }, 404);

      const response = await readResumeResponse(request);
      if (!response) return json({ error: "Invalid approval response" }, 400);

      const sessionApprovals =
        approvalResponses.get(sessionId) ?? new Map<string, ResumeResponse>();
      sessionApprovals.set(executionId, response);
      approvalResponses.set(sessionId, sessionApprovals);
      const waiter = approvalWaiters.get(sessionId)?.get(executionId);
      if (waiter) await Effect.runPromise(Deferred.succeed(waiter, response));

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
