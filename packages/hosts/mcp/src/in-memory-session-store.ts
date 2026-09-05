import { Cause, Data, Effect, Layer } from "effect";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { formatPausedExecution, type ExecutionEngine } from "@executor-js/execution";
import type { OrgWriteAccess } from "@executor-js/sdk";

import {
  buildResumeApprovalUrl,
  decodeResumeResponse,
  formatResumeAcknowledgement,
  readArtifactsEnabled,
  readElicitationMode,
  readPassthroughIntegrations,
  readSearchToolsEnabled,
  readToolMode,
  type McpToolMode,
} from "./browser-approval";
import {
  makeInProcessBrowserApprovalStore,
  type InProcessBrowserApprovalStore,
} from "./browser-approval-store";
import { jsonRpcErrorBody, preInitializeMethodNotFound } from "./envelope";
import {
  McpSessionStore,
  MCP_ORG_WRITE_ACCESS_HEADER,
  defaultMcpResource,
  mcpResourceKey,
  orgWriteAccessForPrincipal,
  principalOwns,
  withOrgWriteAccess,
  type McpDispatchInput,
  type McpDispatchResult,
  type Principal,
  type McpResource,
} from "./seams";
import type { BrowserApprovalStore, McpPassthroughUnavailableError } from "./tool-server";

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

// A streamable-HTTP session only leaves these maps when the client sends
// `DELETE /mcp`, and nothing sends it: `StreamableHTTPClientTransport.close()`
// aborts locally and puts nothing on the wire (only `terminateSession()` sends
// the DELETE, and `Client.close()` does not call it), and a client that crashes
// or is killed cannot send it at all. Without a sweep, one abandoned session
// pins its `McpServer`, its tool registry, and its `ExecutionEngine` for the
// lifetime of the process.
//
// The standalone SSE stream is NOT a substitute teardown signal, and it is not
// absent either. `enableJsonResponse` governs only how a POST carrying requests
// answers; a POST carrying just the `notifications/initialized` notification
// still gets a bare 202, which is exactly the cue the client SDK uses to open
// the long-lived `GET /mcp` stream. So essentially every session holds an open
// server-to-client stream for its whole life. That stream is silent by design
// (it exists for server-initiated messages) and this transport does no max-age
// rotation, so it produces no recurring request to stamp against — an open
// stream tells us the socket is up, never that the peer is still working.
//
// So the store treats a session as abandoned once it has gone `idleTtlMs`
// without a REQUEST and disposes it, open stream or not. That mirrors cloud's
// `decideSessionAlarm`, where an active stream extends the lease only up to
// `MAX_RUNNING_SESSION_IDLE_MS` and the session is then destroyed regardless;
// the default here is that same order of ceiling. It is also what the
// streamable-HTTP spec allows a server to do: a request carrying an evicted id
// gets the store's existing "not-found" (404, -32001), the client's cue to
// re-initialize. The cost is bounded and visible — a connected-but-quiet client
// loses its stream at the ceiling and re-initializes on its next call.
/** Idle window after which an untouched session is evicted. */
const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
/** Floor on the sweep interval, so a small TTL cannot spin the timer. */
const MIN_SWEEP_INTERVAL_MS = 30 * 1000;

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
  /** Whether this session serves artifacts. True unless the client connected
   *  with `?artifacts=false`; opted out, the built server registers none of
   *  the artifact tools, resource, or skills. */
  readonly artifactsEnabled?: boolean;
  /** Whether this session serves the per-integration `search_<integration>`
   *  tools. False unless the client connected with `?search_tools=true`. */
  readonly searchToolsEnabled?: boolean;
  /** The tool surface (`?mode=`): codemode (default) or passthrough. */
  readonly mode?: McpToolMode;
  /** Passthrough only: the `?integrations=` filter. */
  readonly passthroughIntegrations?: readonly string[];
}

/** Build the per-session `McpServer` + engine for a principal (the host's engine + tools). */
export type McpBuildServer = (
  principal: Principal,
  options?: McpBuildServerOptions,
) => Effect.Effect<BuiltMcpServer, McpEngineBuildError | McpPassthroughUnavailableError>;

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
  /** Number of live initialized sessions currently owned by this store. */
  readonly sessionCount: () => number;
  /**
   * Dispose every session idle past the store's TTL and return how many went.
   * Runs on a timer; exposed so a host (or a test) can drive it directly.
   */
  readonly sweepIdleSessions: (now?: number) => Promise<number>;
  /** Dispose every live session — wire into the host's shutdown (not a seam). */
  readonly close: () => Promise<void>;
}

const formatBoundaryError = (error: unknown): unknown =>
  // oxlint-disable-next-line executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: log unknown MCP SDK/runtime failures
  error instanceof Error ? (error.stack ?? error.message) : error;

/** One session handle refused to close. Reported, never propagated. */
class McpHandleCloseError extends Data.TaggedError("McpHandleCloseError")<{
  readonly cause: unknown;
}> {}

/**
 * Release one session handle, best effort. Disposal must finish even when a
 * handle refuses to close — the other handles still have to go, and a rejection
 * here would surface as an unhandled rejection on a sweep tick nobody awaits.
 * But a silently swallowed failure is a leaked transport, server, or engine that
 * nothing can see, so name the handle and the session in a warning.
 */
const ignoreClose = (
  sessionId: string | null,
  handle: string,
  close: (() => Promise<void>) | undefined,
): Promise<void> => {
  if (!close) return Promise.resolve();
  const warn = (detail: unknown): Effect.Effect<void> =>
    Effect.sync(() => {
      console.warn(
        `[mcp] failed to close ${handle} for session ${sessionId ?? "<uninitialized>"}:`,
        formatBoundaryError(detail),
      );
    });
  return Effect.runPromise(
    Effect.tryPromise({ try: close, catch: (cause) => new McpHandleCloseError({ cause }) }).pipe(
      Effect.catch((error) => warn(error.cause)),
      // A defect cannot escape either: this runs detached from any request.
      Effect.catchCause((cause) => warn(Cause.squash(cause))),
    ),
  );
};

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
  options: {
    readonly webBaseUrl?: string;
    /** Idle window before a session is evicted. 0 disables eviction. */
    readonly sessionIdleTtlMs?: number;
    /** How often the sweep runs. Defaults to a quarter of the TTL. */
    readonly sessionSweepIntervalMs?: number;
  } = {},
): InMemoryMcpSessionStore => {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();
  const owners = new Map<string, SessionOwner>();
  const engines = new Map<string, ExecutionEngine<Cause.YieldableError>>();
  const approvals: InProcessBrowserApprovalStore = makeInProcessBrowserApprovalStore();
  // Monotonic-ish last-touch stamp per live session, the first input the idle
  // sweep reads. Written on create and on every forwarded request.
  const lastSeen = new Map<string, number>();
  // Requests currently inside `transport.handleRequest` for a session, the
  // sweep's second input. A stamp alone cannot describe a long call: it is
  // written BEFORE the await, so a single `execute` that outruns the TTL (a
  // browser approval waiting on a human, a slow upstream) would look exactly
  // like an abandoned session and have its transport, server, and engine closed
  // out from under the request that is still using them. Counting requests in
  // flight makes "idle" mean what it says.
  const activeRequests = new Map<string, number>();

  const idleTtlMs = options.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS;
  const sweepIntervalMs =
    options.sessionSweepIntervalMs ?? Math.max(MIN_SWEEP_INTERVAL_MS, Math.floor(idleTtlMs / 4));

  const touch = (id: string): void => {
    if (lastSeen.has(id)) lastSeen.set(id, Date.now());
  };

  /** Claim a session for one in-flight request, so the sweep cannot take it. */
  const beginRequest = (id: string): void => {
    activeRequests.set(id, (activeRequests.get(id) ?? 0) + 1);
  };

  /**
   * Release the claim and restamp: a call that ran for an hour leaves the
   * session idle from the moment it FINISHED, not from the moment it started.
   * `touch` is a no-op once the session is gone, so this can never resurrect a
   * disposed id.
   */
  const endRequest = (id: string): void => {
    const remaining = (activeRequests.get(id) ?? 1) - 1;
    if (remaining > 0) activeRequests.set(id, remaining);
    else activeRequests.delete(id);
    touch(id);
  };

  /**
   * Shut down a session's engine. Dropping the reference is not enough: the
   * engine's paused executions hold detached sandbox fibers that keep running —
   * and keep querying the host's database handle — until `shutdown` interrupts
   * them. Every disposal path goes through here.
   */
  const shutdownEngine = (
    id: string | null,
    engine: ExecutionEngine<Cause.YieldableError> | undefined,
  ): Promise<void> =>
    ignoreClose(id, "engine", engine ? () => Effect.runPromise(engine.shutdown) : undefined);

  const dispose = async (id: string, opts: { transport?: boolean; server?: boolean } = {}) => {
    const transport = transports.get(id);
    const server = servers.get(id);
    const engine = engines.get(id);
    transports.delete(id);
    servers.delete(id);
    owners.delete(id);
    engines.delete(id);
    lastSeen.delete(id);
    activeRequests.delete(id);
    if (opts.transport)
      await ignoreClose(id, "transport", transport ? () => transport.close() : undefined);
    if (opts.server) await ignoreClose(id, "server", server ? () => server.close() : undefined);
    await shutdownEngine(id, engine);
  };

  /**
   * Drive a transport for one web request, recovering any defect to a 500. On a
   * fresh transport that never minted a session id (e.g. a non-initialize first
   * request), close it and its server eagerly so they don't leak. The SDK
   * transport rejects malformed or literal-null POST bodies before dispatch;
   * every request that reaches dispatch has its org-write-access header
   * overwritten below with the value derived from the authenticated principal.
   */
  const runHandleRequest = (
    transport: WebStandardStreamableHTTPServerTransport,
    request: Request,
    orgWriteAccess: OrgWriteAccess,
    onClose?: () => void,
  ): Effect.Effect<Response> => {
    const finish = (): void => {
      if (onClose && !transport.sessionId) onClose();
    };
    const handle =
      request.method === "POST"
        ? Effect.tryPromise({
            try: () => request.json(),
            catch: () => null,
          }).pipe(
            Effect.orElseSucceed(() => null),
            Effect.flatMap((parsedBody) => {
              if (parsedBody === null)
                return Effect.promise(() => transport.handleRequest(request));
              const headers = new Headers(request.headers);
              headers.set(MCP_ORG_WRITE_ACCESS_HEADER, orgWriteAccess);
              const bodylessRequest = new Request(request.url, {
                method: request.method,
                headers,
                signal: request.signal,
              });
              return Effect.promise(() => transport.handleRequest(bodylessRequest, { parsedBody }));
            }),
          )
        : Effect.promise(() =>
            transport.handleRequest(withOrgWriteAccess(request, orgWriteAccess)),
          );
    return handle.pipe(
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
    owners.set(sessionId, { principal, resource });
    touch(sessionId);
    // Claim before the await, release in the finalizer — `runHandleRequest`
    // already recovers every failure to a 500, but `ensuring` also covers an
    // interrupt, so the counter cannot be left permanently raised (which would
    // make the session immortal, the opposite leak).
    beginRequest(sessionId);
    return runHandleRequest(transport, request, orgWriteAccessForPrincipal(principal)).pipe(
      Effect.ensuring(Effect.sync(() => endRequest(sessionId))),
    );
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
    const artifactsEnabled = readArtifactsEnabled(request);
    const searchToolsEnabled = readSearchToolsEnabled(request);
    const toolMode = readToolMode(request);
    const passthroughIntegrations = readPassthroughIntegrations(request);
    const surface = {
      artifactsEnabled,
      searchToolsEnabled,
      mode: toolMode,
      ...(passthroughIntegrations ? { passthroughIntegrations } : {}),
    };
    const mode = readElicitationMode(request);
    if (mode !== "browser") {
      return { ...surface, elicitationMode: { mode } };
    }
    return {
      ...surface,
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
  const openSession = (
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
              lastSeen.set(sid, Date.now());
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
          return yield* runHandleRequest(
            transport,
            request,
            orgWriteAccessForPrincipal(principal),
            () => {
              // Nothing was ever registered under a session id, so `dispose` has
              // no entry to work from — release the three handles by hand, engine
              // included.
              void ignoreClose(null, "transport", () => transport.close());
              void ignoreClose(null, "server", () => mcpServer.close());
              void shutdownEngine(null, engine);
            },
          );
        }),
      ),
      // A build failure has nowhere typed to go in the envelope; render a 500.
      Effect.catchTags({
        McpEngineBuildError: () =>
          Effect.succeed(jsonRpcError(500, -32603, "Internal server error")),
        McpPassthroughUnavailableError: () =>
          Effect.succeed(jsonRpcError(500, -32603, "Internal server error")),
      }),
    );
  };

  /**
   * The session-less POST path: answer a probe for anything but `initialize`
   * with -32601 (see `preInitializeMethodNotFound`) rather than let the
   * transport reject it with a connection-killing 400, and only then build a
   * server and open a session.
   */
  const create = (
    principal: Principal,
    resource: McpResource,
    request: Request,
  ): Effect.Effect<McpDispatchResult> =>
    preInitializeMethodNotFound(request).pipe(
      Effect.flatMap((unsupported) =>
        unsupported
          ? Effect.succeed<McpDispatchResult>(unsupported)
          : openSession(principal, resource, request),
      ),
    );

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

    await Effect.runPromise(
      approvals.recordResponse(executionId, {
        response,
        orgWriteAccess: principal ? orgWriteAccessForPrincipal(principal) : "allowed",
      }),
    );
    return json({
      status: "completed",
      ...formatResumeAcknowledgement(executionId, response),
      isError: false,
    });
  };

  /**
   * Dispose every session whose last request is older than the idle window AND
   * which has nothing in flight. A session serving a request is busy, however
   * long ago that request started; it gets a fresh stamp the moment it ends, so
   * a later sweep still reclaims it if the client then goes quiet.
   */
  const sweepIdleSessions = async (now: number = Date.now()): Promise<number> => {
    if (idleTtlMs <= 0) return 0;
    const stale = [...lastSeen.entries()]
      .filter(([id, seen]) => now - seen >= idleTtlMs && (activeRequests.get(id) ?? 0) === 0)
      .map(([id]) => id);
    // Both flags: an evicted session's transport has no other owner, and leaving
    // it open would keep the very handles the eviction exists to release.
    await Promise.all(stale.map((id) => dispose(id, { transport: true, server: true })));
    return stale.length;
  };

  // `unref` so the sweep never keeps a host process alive on its own. Node and
  // Bun both return a Timeout with it; the DOM typing does not, hence the guard.
  const sweepTimer: ReturnType<typeof setInterval> | undefined =
    idleTtlMs > 0
      ? setInterval(() => {
          // Same shape as `ignoreClose`: a sweep failure is not the host's
          // problem and must never surface as an unhandled rejection.
          void Effect.runPromise(
            Effect.ignore(
              Effect.tryPromise({ try: () => sweepIdleSessions(), catch: () => undefined }),
            ),
          );
        }, sweepIntervalMs)
      : undefined;
  (sweepTimer as { unref?: () => void } | undefined)?.unref?.();

  return {
    store,
    handlePausedRequest,
    handleApprovalRequest,
    sessionCount: () => transports.size,
    sweepIdleSessions,
    close: async () => {
      if (sweepTimer !== undefined) clearInterval(sweepTimer);
      const ids = new Set([...transports.keys(), ...servers.keys(), ...engines.keys()]);
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
