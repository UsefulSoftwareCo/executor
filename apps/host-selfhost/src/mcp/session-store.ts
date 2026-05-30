import { Data, Effect, Layer } from "effect";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { ErrorCapture } from "@executor-js/api";
import {
  jsonRpcErrorBody,
  McpErrorReporter,
  McpSessionStore,
  principalOwns,
  type McpDispatchInput,
  type McpDispatchResult,
  type Principal,
} from "@executor-js/host-mcp";
import { createExecutorMcpServer } from "@executor-js/host-mcp/tool-server";

import { ErrorCaptureLive } from "../observability";
import { SelfHostDb, type SelfHostDbHandle } from "../db/self-host-db";
import { makeExecutionStack, SelfHostExecutionStackLayer } from "../execution";

// ---------------------------------------------------------------------------
// Self-host McpSessionStore adapter — in-process, no Durable Objects.
//
// In the two-seam envelope the store owns the ENTIRE session lifecycle via
// `dispatch`: create (no session id + POST initialize), forward (session id
// present), and ownership (cross-bearer). Three Maps keyed by mcp-session-id —
// transports, servers, owners — hold the live in-process sessions. Fine for a
// single-node self-host; cloud's DO store is the cross-isolate variant of the
// same seam. The per-user executor is a plain value over the shared DB, so
// closing a session is just closing its transport + server.
//
// The engine is a store implementation detail, not an envelope seam: the store
// builds its per-session `McpServer` via `makeExecutionStack` over the shared
// SelfHostDb (`buildServer` below) + `createExecutorMcpServer`. The two-seam
// envelope has no engine seam — for self-host the store owns engine
// construction; cloud's DO builds its engine inside the DO.
//
// `dispatch` returns the transport `Response` to pass through, or:
//   - "not-found" (unknown session id)            -> envelope renders 404 -32001
//   - "forbidden" (session owned by another bearer) -> envelope renders 403 -32003
// ---------------------------------------------------------------------------

/** Engine construction failed for a principal. The store surfaces it as a 500. */
export class McpEngineBuildError extends Data.TaggedError("McpEngineBuildError")<{
  readonly cause: unknown;
}> {}

const ignoreClose = (close: (() => Promise<void>) | undefined): Promise<void> =>
  close
    ? Effect.runPromise(Effect.ignore(Effect.tryPromise({ try: close, catch: () => undefined })))
    : Promise.resolve();

const formatBoundaryError = (error: unknown): unknown =>
  // oxlint-disable-next-line executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: log unknown MCP SDK/runtime failures
  error instanceof Error ? (error.stack ?? error.message) : error;

// The store's error bodies are INNER responses (no CORS): the serving envelope
// re-wraps the store `Response` with CORS before it leaves the origin, so the
// canonical renderer is called with `cors: false` to stay byte-identical to the
// prior hand-rolled copy (`content-type: application/json` only).
const jsonRpcError = (status: number, code: number, message: string): Response =>
  jsonRpcErrorBody(status, code, message, { cors: false });

/** Build the per-session `McpServer` for a principal (engine + factory config). */
type BuildServer = (principal: Principal) => Effect.Effect<McpServer, McpEngineBuildError>;

interface SelfHostMcpSessionStore {
  readonly store: McpSessionStore["Service"];
  readonly close: () => Promise<void>;
}

/**
 * The store's internal engine boundary: build the per-(user,org) scoped
 * executor over the long-lived `SelfHostDb` (QuickJS code substrate) and hand
 * the engine to `createExecutorMcpServer`. Engine construction reads the
 * long-lived DB, so this closes over the handle captured at boot — no
 * per-request layer plumbing. NOT an envelope seam; the store owns it.
 */
const makeBuildServer =
  (db: SelfHostDbHandle): BuildServer =>
  (principal) =>
    makeExecutionStack(
      principal.accountId,
      principal.organizationId,
      principal.organizationName,
    ).pipe(
      Effect.map(({ engine }) => engine),
      Effect.provide(SelfHostExecutionStackLayer),
      Effect.provideService(SelfHostDb, db),
      Effect.mapError((cause) => new McpEngineBuildError({ cause })),
      Effect.flatMap((engine) => createExecutorMcpServer({ engine })),
    );

/**
 * Build the in-process session store plus an explicit `close()` that disposes
 * all live sessions (wired into the app's shutdown). `close()` is not part of
 * the seam — it is the self-host lifetime hook the envelope doesn't own. The
 * store builds its per-session engine over the long-lived `SelfHostDb` handle.
 */
export const makeSelfHostMcpSessionStore = (db: SelfHostDbHandle): SelfHostMcpSessionStore => {
  const buildServer = makeBuildServer(db);
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();
  const owners = new Map<string, Principal>();

  const dispose = async (id: string, opts: { transport?: boolean; server?: boolean } = {}) => {
    const transport = transports.get(id);
    const server = servers.get(id);
    transports.delete(id);
    servers.delete(id);
    owners.delete(id);
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
    request: Request,
  ): Effect.Effect<McpDispatchResult> => {
    const transport = transports.get(sessionId);
    const owner = owners.get(sessionId);
    if (!transport || !owner) return Effect.succeed("not-found");
    if (!principalOwns(owner, principal)) return Effect.succeed("forbidden");
    return runHandleRequest(transport, request);
  };

  /** Open a new session: build the server, connect a transport, drive the request. */
  const create = (principal: Principal, request: Request): Effect.Effect<McpDispatchResult> =>
    buildServer(principal).pipe(
      Effect.flatMap((server) =>
        Effect.gen(function* () {
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (sid) => {
              transports.set(sid, transport);
              servers.set(sid, server);
              owners.set(sid, principal);
            },
            onsessionclosed: (sid) => void dispose(sid, { server: true }),
          });
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) void dispose(sid, { server: true });
          };
          yield* Effect.promise(() => server.connect(transport));
          // The session id is minted on the first (initialize) request, so we
          // drive `handleRequest` here; if no id results we close eagerly.
          return yield* runHandleRequest(transport, request, () => {
            void ignoreClose(() => transport.close());
            void ignoreClose(() => server.close());
          });
        }),
      ),
      // A build failure has nowhere typed to go in the envelope; render a 500.
      Effect.catchTag("McpEngineBuildError", () =>
        Effect.succeed(jsonRpcError(500, -32603, "Internal server error")),
      ),
    );

  const store: McpSessionStore["Service"] = {
    dispatch: ({ request, principal, sessionId }: McpDispatchInput) =>
      sessionId ? forward(sessionId, principal, request) : create(principal, request),
    dispose: (sessionId) =>
      Effect.promise(() => dispose(sessionId, { transport: true, server: true })),
  };

  return {
    store,
    close: async () => {
      const ids = new Set([...transports.keys(), ...servers.keys()]);
      await Promise.all([...ids].map((id) => dispose(id, { transport: true, server: true })));
    },
  };
};

/**
 * Layer wrapping a freshly built in-process store, the `McpSessionStore`
 * envelope seam. The owning app calls `makeSelfHostMcpSessionStore(db)` directly
 * so it can wire the `close()` lifetime hook into shutdown, then passes the
 * built store here.
 */
export const selfHostMcpSessions = (built: SelfHostMcpSessionStore): Layer.Layer<McpSessionStore> =>
  Layer.succeed(McpSessionStore)(built.store);

// ---------------------------------------------------------------------------
// Self-host McpErrorReporter seam — reuses the shared `ErrorCapture` service so
// a request-orchestration defect the shared MCP envelope is about to render as a
// JSON-RPC 500 still flows through the host's normal capture pipeline (self-host:
// the console `ErrorCaptureLive`). Without this seam override the envelope
// swallows the cause into a `Response` and the operator never sees it.
// ---------------------------------------------------------------------------

export const selfHostMcpReporter: Layer.Layer<McpErrorReporter> = Layer.effect(
  McpErrorReporter,
  Effect.gen(function* () {
    const capture = yield* ErrorCapture;
    return {
      report: (cause) => Effect.asVoid(capture.captureException(cause)),
    };
  }),
).pipe(Layer.provide(ErrorCaptureLive));
