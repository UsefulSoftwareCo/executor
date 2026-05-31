// ---------------------------------------------------------------------------
// The Durable-Object-backed McpSessionStore — the cross-isolate variant of the
// shared host-mcp session seam. Shared by every Cloudflare host (cloud +
// host-cloudflare); a host supplies ONLY its DO namespace accessors (newStub
// for create, getStub for forward, addressed by the session-id == DO-id) and an
// optional internal-error reporter. Everything else — identity-header stamping,
// W3C trace propagation, response peeking, the verbatim DO error passthrough —
// is platform-generic.
//
// `dispatch` owns the worker-isolate orchestration:
//   - sessionId null  + POST initialize -> newStub() -> init(meta) + handleRequest
//   - sessionId present -> getStub(id) -> handleRequest (the DO id routes back to
//     the same isolate, which is the whole point — sessions survive across the
//     worker's stateless isolates).
//
// IMPORTANT: the DO `Response` is returned VERBATIM (incl. its 403 -32003 /
// 404 -32001 error bodies) — the envelope's "forbidden"/"not-found" discriminants
// would emit different message bytes. The envelope short-circuits bare GET (400)
// and DELETE (204) before dispatch, so dispatch only sees create or forward.
// ---------------------------------------------------------------------------

import { Effect, Layer } from "effect";

import {
  McpSessionStore,
  type McpDispatchInput,
  type McpDispatchResult,
} from "@executor-js/host-mcp";

import {
  currentPropagationHeaders,
  readElicitationMode,
  withMcpResponseHeaders,
  withPropagationHeaders,
  withVerifiedIdentityHeaders,
  type VerifiedTokenHeaders,
} from "./do-headers";
import { peekAndAnnotate, type OnInternalJsonRpcError } from "./response-peek";
import type { McpSessionDOStub } from "./seams";

export type { McpSessionDOStub, McpSessionInit } from "./seams";

export interface DurableObjectStoreConfig {
  /** Resolve the stub for an existing session id (the id IS the DO id). */
  readonly getStub: (sessionId: string) => McpSessionDOStub;
  /** Mint a fresh session DO stub (a new unique id) for a create. */
  readonly newStub: () => McpSessionDOStub;
  /** Observe a JSON-RPC -32603 the peeker surfaces (cloud: Sentry). */
  readonly onInternalError?: OnInternalJsonRpcError;
}

/**
 * Forward a request to an existing session DO. `peek` tees the body for
 * telemetry on POST/DELETE; GET (SSE) streams through untouched. Returns the DO
 * `Response` verbatim (incl. its 403 -32003 / 404 -32001 error bodies).
 */
const forwardToExistingSession = (
  config: DurableObjectStoreConfig,
  request: Request,
  sessionId: string,
  peek: boolean,
  token: VerifiedTokenHeaders,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const stub = config.getStub(sessionId);
    const propagation = yield* currentPropagationHeaders(request);
    const propagated = withPropagationHeaders(
      withVerifiedIdentityHeaders(request, token),
      propagation,
    );
    const raw = yield* Effect.promise(() => stub.handleRequest(propagated)).pipe(
      Effect.withSpan("mcp.do.handle_request", {
        attributes: {
          "mcp.request.method": request.method,
          "mcp.request.session_id_present": true,
        },
      }),
    );
    const annotated = peek
      ? yield* peekAndAnnotate(raw, { onInternalError: config.onInternalError })
      : raw;
    return withMcpResponseHeaders(annotated);
  });

/** Open a new session DO (POST, no session-id): init then handleRequest. */
const createSession = (
  config: DurableObjectStoreConfig,
  request: Request,
  token: VerifiedTokenHeaders,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const stub = config.newStub();
    const propagation = yield* currentPropagationHeaders(request);
    yield* Effect.promise(() =>
      stub.init(
        {
          organizationId: token.organizationId,
          userId: token.accountId,
          elicitationMode: readElicitationMode(request),
          // The public origin the client reached us at — lets the DO derive a web
          // base URL with no static config (we read the real URL, not a spoofable
          // forwarded host).
          webOrigin: new URL(request.url).origin,
        },
        propagation,
      ),
    ).pipe(
      Effect.withSpan("mcp.do.init", {
        attributes: { "mcp.request.session_id_present": false },
      }),
    );
    const propagated = withPropagationHeaders(
      withVerifiedIdentityHeaders(request, token),
      propagation,
    );
    const raw = yield* Effect.promise(() => stub.handleRequest(propagated)).pipe(
      Effect.withSpan("mcp.do.handle_request", {
        attributes: {
          "mcp.request.method": request.method,
          "mcp.request.session_id_present": false,
        },
      }),
    );
    const annotated = yield* peekAndAnnotate(raw, { onInternalError: config.onInternalError });
    return withMcpResponseHeaders(annotated);
  });

const clearExistingSession = (
  config: DurableObjectStoreConfig,
  sessionId: string,
  request?: Request,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const stub = config.getStub(sessionId);
    // Disposal carries the active request's trace context (tracestate/baggage)
    // when the envelope forwards the inbound request (the Forbidden-with-session
    // teardown); otherwise a synthetic request, with traceparent still linking
    // the span via the active Effect span.
    const propagation = yield* currentPropagationHeaders(
      request ?? new Request("https://mcp.invalid/mcp"),
    );
    yield* Effect.promise(() => stub.clearSession(propagation)).pipe(
      Effect.catchCause(() => Effect.void),
      Effect.withSpan("mcp.do.clear_session", {
        attributes: { "mcp.request.session_id_present": true },
      }),
    );
  });

/**
 * Build the `McpSessionStore` seam over a host's DO namespace. Cloud and
 * host-cloudflare each pass their `getStub`/`newStub` (over `env.MCP_SESSION`);
 * the dispatch logic is identical.
 */
export const makeDurableObjectMcpSessionStore = (
  config: DurableObjectStoreConfig,
): Layer.Layer<McpSessionStore> =>
  Layer.succeed(McpSessionStore)({
    dispatch: ({
      request,
      principal,
      sessionId,
    }: McpDispatchInput): Effect.Effect<McpDispatchResult> => {
      const token: VerifiedTokenHeaders = {
        accountId: principal.accountId,
        organizationId: principal.organizationId,
      };
      return sessionId
        ? forwardToExistingSession(config, request, sessionId, request.method !== "GET", token)
        : createSession(config, request, token);
    },
    dispose: (sessionId, request) => clearExistingSession(config, sessionId, request),
  });
