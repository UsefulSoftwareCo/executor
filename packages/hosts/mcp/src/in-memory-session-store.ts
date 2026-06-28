import { Cause, Data, Effect, Layer } from "effect";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { formatPausedExecution, type ExecutionEngine } from "@executor-js/execution";

import {
  buildResumeApprovalUrl,
  decodeResumeResponse,
  formatResumeAcknowledgement,
  readElicitationMode,
} from "./browser-approval";
import {
  makeInProcessBrowserApprovalStore,
  type InProcessBrowserApprovalStore,
} from "./browser-approval-store";
import { jsonRpcErrorBody } from "./envelope";
import {
  McpSessionStore,
  defaultMcpResource,
  mcpResourceKey,
  principalOwns,
  type McpDispatchInput,
  type McpDispatchResult,
  type Principal,
  type McpResource,
} from "./seams";
import type { BrowserApprovalStore } from "./tool-server";

// ---------------------------------------------------------------------------
// In-process McpSessionStore — the single-node serving store, shared by every
// host that has no cross-isolate session backend (self-host, the local app).
// Cloud's Durable Object store is the cross-isolate variant of the same
// `McpSessionStore` seam.
//
// In the two-seam envelope the store owns the ENTIRE session lifecycle via
// `dispatch`: create (no session id + POST initialize), forward (session id
// present), and ownership (cross-bearer). Maps keyed by mcp-session-id hold the
// live in-process sessions: transports, servers, owners, and — for the browser
// approval flow — the per-session engines.
//
// Browser approval: when the create request carries `?elicitation_mode=browser`,
// the store builds the session's server in browser mode (an `approvalUrl` + the
// shared in-process approval store) and keeps the session's engine so the HTTP
// approval endpoints (`handlePausedRequest` / `handleApprovalRequest`) can read
// the paused execution and record the human's decision. The Durable Object
// hosts do the equivalent with `ctx.storage`.
//
// `dispatch` returns the transport `Response` to pass through, or:
//   - "not-found" (unknown session id)              -> envelope renders 404 -32001
//   - "forbidden" (session owned by another bearer) -> envelope renders 403 -32003
// ---------------------------------------------------------------------------

/** Engine construction failed for a principal. The store surfaces it as a 500. */
export class McpEngineBuildError extends Data.TaggedError("McpEngineBuildError")<{
  readonly cause: unknown;
}> {}

/** The connected MCP server plus the engine the approval endpoints drive. */
export interface BuiltMcpServer {
  readonly mcpServer: McpServer;
  readonly engine: ExecutionEngine<Cause.YieldableError>;
}

/** The browser-mode wiring the store hands a build call when a session opts in. */
export interface McpBuildServerOptions {
  readonly resource?: McpResource;
  readonly elicitationMode?:
    | { readonly mode: "browser"; readonly approvalUrl: (executionId: string) => string }
    | { readonly mode: "model" }
    | { readonly mode: "native" };
  readonly browserApprovalStore?: BrowserApprovalStore;
}

/** Build the per-session `McpServer` + engine for a principal (the host's engine + tools). */
export type McpBuildServer = (
  principal: Principal,
  options?: McpBuildServerOptions,
) => Effect.Effect<BuiltMcpServer, McpEngineBuildError>;

export interface InMemoryMcpSessionStore {
  /** The `McpSessionStore` seam value to hand to `inMemoryMcpSessionsLayer`. */
  readonly store: McpSessionStore["Service"];
  /**
   * Serve `GET /api/mcp-sessions/:sessionId/executions/:executionId` — the
   * paused-execution detail the console approval page renders. Returns the
   * paused `{ text, structured }` or a 404. Null if the path does not match.
   */
  readonly handlePausedRequest: (
    request: Request,
    principal?: Principal,
  ) => Promise<Response | null>;
  /**
   * Serve `POST /api/mcp-sessions/:sessionId/executions/:executionId/resume` —
   * record the human's decision and wake the long-polling `resume` tool call.
   * Null if the path does not match.
   */
  readonly handleApprovalRequest: (
    request: Request,
    principal?: Principal,
  ) => Promise<Response | null>;
  /** Dispose every live session — wire into the host's shutdown (not a seam). */
  readonly close: () => Promise<void>;
}

const ignoreClose = (close: (() => Promise<void>) | undefined): Promise<void> =>
  close
    ? Effect.runPromise(Effect.ignore(Effect.tryPromise({ try: close, catch: () => undefined })))
    : Promise.resolve();

const formatBoundaryError = (error: unknown): unknown =>
  // oxlint-disable-next-line executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: log unknown MCP SDK/runtime failures
  error instanceof Error ? (error.stack ?? error.message) : error;

// The store's error bodies are INNER responses (no CORS): the serving envelope
// re-wraps the store `Response` with CORS before it leaves the origin, so the
// canonical renderer is called with `cors: false` (content-type only).
const jsonRpcError = (status: number, code: number, message: string): Response =>
  jsonRpcErrorBody(status, code, message, { cors: false });

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const PAUSED_PATH = /^\/api\/mcp-sessions\/([^/?#]+)\/executions\/([^/?#]+)$/;
const RESUME_PATH = /^\/api\/mcp-sessions\/([^/?#]+)\/executions\/([^/?#]+)\/resume$/;

interface SessionOwner {
  readonly principal: Principal;
  readonly resource: McpResource;
}

const sessionOwnerMatches = (
  owner: SessionOwner,
  principal: Principal,
  resource: McpResource,
): boolean =>
  principalOwns(owner.principal, principal) &&
  mcpResourceKey(owner.resource) === mcpResourceKey(resource);

/**
 * Build the in-process session store plus an explicit `close()` that disposes
 * all live sessions. `close()` is not part of the seam — it is the host lifetime
 * hook the envelope doesn't own. Each per-session engine comes from the
 * host-supplied `buildServer`.
 */
export const makeInMemoryMcpSessionStore = (
  buildServer: McpBuildServer,
  // The host's pinned public origin, used to build browser-approval URLs the
  // human opens. When set (e.g. a public-internet self-host behind a reverse
  // proxy) it is preferred over the request URL — whose host would be the
  // internal bind address (127.0.0.1:PORT), unreachable for the user. Omit it on
  // loopback hosts (local/desktop), where the request URL is already correct.
  options: { readonly webBaseUrl?: string } = {},
): InMemoryMcpSessionStore => {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();
  const owners = new Map<string, SessionOwner>();
  const engines = new Map<string, ExecutionEngine<Cause.YieldableError>>();
  const approvals: InProcessBrowserApprovalStore = makeInProcessBrowserApprovalStore();

  const dispose = async (id: string, opts: { transport?: boolean; server?: boolean } = {}) => {
    const transport = transports.get(id);
    const server = servers.get(id);
    transports.delete(id);
    servers.delete(id);
    owners.delete(id);
    engines.delete(id);
    if (opts.transport) await ignoreClose(transport ? () => transport.close() : undefined);
    if (opts.server) await ignoreClose(server ? () => server.close() : undefined);
  };

  /**
   * Drive a transport for one web request, recovering any defect to a 500. On a
   * fresh transport that never minted a session id (e.g. a non-initialize first
   * request), close it and its server eagerly so they don't leak.
   */
  const runHandleRequest = (
    transport: WebStandardStreamableHTTPServerTransport,
    request: Request,
    onClose?: () => void,
  ): Effect.Effect<Response> => {
    const finish = (): void => {
      if (onClose && !transport.sessionId) onClose();
    };
    return Effect.promise(() => transport.handleRequest(request)).pipe(
      Effect.tap(() => Effect.sync(finish)),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          console.error("[mcp] handleRequest error:", formatBoundaryError(cause));
          finish();
          return jsonRpcError(500, -32603, "Internal server error");
        }),
      ),
    );
  };

  /** Forward to an existing session, enforcing ownership against the principal. */
  const forward = (
    sessionId: string,
    principal: Principal,
    resource: McpResource,
    request: Request,
  ): Effect.Effect<McpDispatchResult> => {
    const transport = transports.get(sessionId);
    const owner = owners.get(sessionId);
    if (!transport || !owner) return Effect.succeed("not-found");
    if (!sessionOwnerMatches(owner, principal, resource)) return Effect.succeed("forbidden");
    return runHandleRequest(transport, request);
  };

  /**
   * The browser-mode wiring for a create request: when the client asks for
   * `elicitation_mode=browser`, build the server with an `approvalUrl` (anchored
   * at the request origin + the session id, minted on initialize) and the shared
   * approval store. Otherwise pass the bare model/native mode through.
   */
  const buildOptionsFor = (
    request: Request,
    sessionId: () => string | null,
  ): McpBuildServerOptions => {
    if (readElicitationMode(request) !== "browser") return { elicitationMode: { mode: "model" } };
    return {
      elicitationMode: {
        mode: "browser",
        // Prefer the pinned public origin; fall back to the request URL (correct
        // for loopback hosts, the internal bind address behind a proxy).
        approvalUrl: (executionId) =>
          buildResumeApprovalUrl({
            origin: options.webBaseUrl ?? request.url,
            executionId,
            sessionId: sessionId(),
          }),
      },
      browserApprovalStore: approvals.store,
    };
  };

  /** Open a new session: build the server, connect a transport, drive the request. */
  const create = (
    principal: Principal,
    resource: McpResource,
    request: Request,
  ): Effect.Effect<McpDispatchResult> => {
    let createdSessionId: string | null = null;
    return buildServer(principal, {
      ...buildOptionsFor(request, () => createdSessionId),
      resource,
    }).pipe(
      Effect.flatMap(({ mcpServer, engine }) =>
        Effect.gen(function* () {
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (sid) => {
              createdSessionId = sid;
              transports.set(sid, transport);
              servers.set(sid, mcpServer);
              owners.set(sid, { principal, resource });
              engines.set(sid, engine);
            },
            onsessionclosed: (sid) => void dispose(sid, { server: true }),
          });
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) void dispose(sid, { server: true });
          };
          yield* Effect.promise(() => mcpServer.connect(transport));
          // The session id is minted on the first (initialize) request, so we
          // drive `handleRequest` here; if no id results we close eagerly.
          return yield* runHandleRequest(transport, request, () => {
            void ignoreClose(() => transport.close());
            void ignoreClose(() => mcpServer.close());
          });
        }),
      ),
      // A build failure has nowhere typed to go in the envelope; render a 500.
      Effect.catchTag("McpEngineBuildError", () =>
        Effect.succeed(jsonRpcError(500, -32603, "Internal server error")),
      ),
    );
  };

  const store: McpSessionStore["Service"] = {
    dispatch: ({ request, principal, resource, sessionId }: McpDispatchInput) =>
      sessionId
        ? forward(sessionId, principal, resource, request)
        : create(principal, resource ?? defaultMcpResource, request),
    dispose: (sessionId) =>
      Effect.promise(() => dispose(sessionId, { transport: true, server: true })),
  };

  const ownerAccess = (
    sessionId: string,
    principal: Principal | undefined,
  ): "allowed" | "not-found" | "forbidden" => {
    const owner = owners.get(sessionId);
    if (!owner) return "not-found";
    if (principal && !principalOwns(owner.principal, principal)) return "forbidden";
    return "allowed";
  };

  /** Resolve a paused execution from the session that owns it, for HTTP approval. */
  const pausedFromSession = (
    sessionId: string,
    executionId: string,
  ): Promise<ReturnType<typeof formatPausedExecution> | null> => {
    const engine = engines.get(sessionId);
    if (!engine) return Promise.resolve(null);
    return Effect.runPromise(
      engine.getPausedExecution(executionId).pipe(
        Effect.map((paused) => (paused ? formatPausedExecution(paused) : null)),
        Effect.orElseSucceed(() => null),
      ),
    );
  };

  const handlePausedRequest = async (
    request: Request,
    principal?: Principal,
  ): Promise<Response | null> => {
    const match = PAUSED_PATH.exec(new URL(request.url).pathname);
    if (!match) return null;
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const sessionId = decodeURIComponent(match[1]!);
    const access = ownerAccess(sessionId, principal);
    if (access === "forbidden") return json({ error: "Forbidden" }, 403);
    if (access === "not-found") return json({ error: "Paused execution not found" }, 404);
    const paused = await pausedFromSession(sessionId, decodeURIComponent(match[2]!));
    if (!paused) return json({ error: "Paused execution not found" }, 404);
    return json({ text: paused.text, structured: paused.structured });
  };

  const handleApprovalRequest = async (
    request: Request,
    principal?: Principal,
  ): Promise<Response | null> => {
    const match = RESUME_PATH.exec(new URL(request.url).pathname);
    if (!match) return null;
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const sessionId = decodeURIComponent(match[1]!);
    const executionId = decodeURIComponent(match[2]!);
    const access = ownerAccess(sessionId, principal);
    if (access === "forbidden") return json({ error: "Forbidden" }, 403);
    if (access === "not-found") return json({ error: "Paused execution not found" }, 404);
    // The session must still hold the paused execution — guards stale ids and
    // confirms the execution belongs to this session before recording.
    const paused = await pausedFromSession(sessionId, executionId);
    if (!paused) return json({ error: "Paused execution not found" }, 404);

    const raw = await Effect.runPromise(
      Effect.tryPromise({ try: () => request.json(), catch: () => null }).pipe(
        Effect.orElseSucceed(() => null),
      ),
    );
    const response = raw === null ? null : decodeResumeResponse(raw);
    if (!response) return json({ error: "Invalid approval response" }, 400);

    await Effect.runPromise(approvals.recordResponse(executionId, response));
    return json({
      status: "completed",
      ...formatResumeAcknowledgement(executionId, response),
      isError: false,
    });
  };

  return {
    store,
    handlePausedRequest,
    handleApprovalRequest,
    close: async () => {
      const ids = new Set([...transports.keys(), ...servers.keys()]);
      await Promise.all([...ids].map((id) => dispose(id, { transport: true, server: true })));
    },
  };
};

/**
 * Layer wrapping a freshly built in-process store, the `McpSessionStore`
 * envelope seam. The owning app calls `makeInMemoryMcpSessionStore(buildServer)`
 * directly so it can wire the `close()` lifetime hook into shutdown, then passes
 * the built store here.
 */
export const inMemoryMcpSessionsLayer = (
  built: InMemoryMcpSessionStore,
): Layer.Layer<McpSessionStore> => Layer.succeed(McpSessionStore)(built.store);
