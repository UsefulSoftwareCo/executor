// ---------------------------------------------------------------------------
// Cloud McpSessionStore adapter — the Durable-Object-backed variant of the
// shared host-mcp session seam (cloud's analog of the self-host in-process
// store).
//
// `dispatch` owns the OUTER worker-isolate orchestration (the helpers it uses
// live in ./do-headers + ./response-peek):
//   - choose the DO stub (newUniqueId for create vs idFromString for forward)
//   - stub.init(...) on create, stub.handleRequest(...) on forward/create
//   - identity-header injection (withVerifiedIdentityHeaders) + trace
//     propagation (withPropagationHeaders + currentPropagationHeaders)
//   - response post-processing (peekAndAnnotate, withMcpResponseHeaders)
//   - elicitation-mode parsing (readElicitationMode)
//
// The DO CLASS internals (engine build + MCP server + transport inside the
// isolate, owner validation against stored meta, restore/suspend, alarm) stay
// UNCHANGED — the store is the DO's cross-isolate engine host.
//
// IMPORTANT: the store returns the DO `Response` VERBATIM for the two cloud
// error shapes so their exact bytes are preserved:
//   - owner mismatch  -> 403 -32003 "MCP session does not belong to the current bearer"
//   - timed out        -> 404 -32001 "Session timed out due to inactivity — please reconnect"
// Returning the DO Response (not the seam's "forbidden"/"not-found"
// discriminants) keeps the "does not belong" / "timed out" message assertions
// byte-for-byte. (The envelope's "forbidden" discriminant happens to render the
// identical 403 -32003 body, but "not-found" would emit a generic "Session not
// found" message, so for that path the DO Response is mandatory.)
//
// The envelope short-circuits a bare GET (400) and bare DELETE (204) BEFORE
// calling dispatch, so the store only ever sees create (POST, no session-id) or
// forward (any method, session-id present).
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";

import {
  McpSessionStore,
  type McpDispatchInput,
  type McpDispatchResult,
} from "@executor-js/host-mcp";

import { peekAndAnnotate } from "./response-peek";
import {
  currentPropagationHeaders,
  readElicitationMode,
  withMcpResponseHeaders,
  withPropagationHeaders,
  withVerifiedIdentityHeaders,
  type VerifiedTokenHeaders,
} from "./do-headers";

/**
 * Forward a request to an existing session DO. `peek` tees the body for
 * telemetry on POST/DELETE; GET (SSE) streams through untouched. Returns the
 * DO `Response` verbatim (incl. its 403 -32003 / 404 -32001 error bodies).
 */
const forwardToExistingSession = (
  request: Request,
  sessionId: string,
  peek: boolean,
  token: VerifiedTokenHeaders,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const ns = env.MCP_SESSION;
    const stub = ns.get(ns.idFromString(sessionId));
    const propagation = yield* currentPropagationHeaders(request);
    const propagated = withPropagationHeaders(
      withVerifiedIdentityHeaders(request, token),
      propagation,
    );
    const raw = yield* Effect.promise(
      () => stub.handleRequest(propagated) as Promise<Response>,
    ).pipe(
      Effect.withSpan("mcp.do.handle_request", {
        attributes: {
          "mcp.request.method": request.method,
          "mcp.request.session_id_present": true,
        },
      }),
    );
    const annotated = peek ? yield* peekAndAnnotate(raw) : raw;
    return withMcpResponseHeaders(annotated);
  });

/** Open a new session DO (POST, no session-id): init then handleRequest. */
const createSession = (request: Request, token: VerifiedTokenHeaders): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const ns = env.MCP_SESSION;
    const stub = ns.get(ns.newUniqueId());
    const propagation = yield* currentPropagationHeaders(request);
    yield* Effect.promise(() =>
      stub.init(
        {
          organizationId: token.organizationId,
          userId: token.accountId,
          elicitationMode: readElicitationMode(request),
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
    const raw = yield* Effect.promise(
      () => stub.handleRequest(propagated) as Promise<Response>,
    ).pipe(
      Effect.withSpan("mcp.do.handle_request", {
        attributes: {
          "mcp.request.method": request.method,
          "mcp.request.session_id_present": false,
        },
      }),
    );
    const annotated = yield* peekAndAnnotate(raw);
    return withMcpResponseHeaders(annotated);
  });

const clearExistingSession = (sessionId: string, request?: Request): Effect.Effect<void> =>
  Effect.gen(function* () {
    const ns = env.MCP_SESSION;
    const stub = ns.get(ns.idFromString(sessionId));
    // Disposal carries trace context from the active request span. When the
    // envelope forwards the inbound request (the Forbidden-with-session
    // teardown), use it so the request's W3C tracestate/baggage propagate onto
    // the clearSession RPC (the OLD clearExistingSession(request, sessionId)
    // behavior); otherwise fall back to a synthetic request (traceparent still
    // links the span via the active Effect span).
    const propagation = yield* currentPropagationHeaders(
      request ?? new Request("https://mcp.invalid/mcp"),
    );
    yield* Effect.promise(() => stub.clearSession(propagation) as Promise<void>).pipe(
      Effect.catchCause(() => Effect.void),
      Effect.withSpan("mcp.do.clear_session", {
        attributes: { "mcp.request.session_id_present": true },
      }),
    );
  });

export const cloudMcpSessionStoreLayer: Layer.Layer<McpSessionStore> = Layer.succeed(
  McpSessionStore,
)({
  dispatch: ({
    request,
    principal,
    sessionId,
  }: McpDispatchInput): Effect.Effect<McpDispatchResult> => {
    // The principal carries the verified account + org used to stamp the DO's
    // identity headers (the DO validates ownership against stored meta).
    const token: VerifiedTokenHeaders = {
      accountId: principal.accountId,
      organizationId: principal.organizationId,
    };
    // The enclosing `mcp.request` span is opened once per request by the cloud
    // McpAuthProvider's `authenticate` (auth-provider.ts), which also carries
    // the client-fingerprint attributes. The DO RPC child spans (`mcp.do.*`)
    // attach to it directly, so dispatch must NOT open a second `mcp.request`.
    return sessionId
      ? forwardToExistingSession(request, sessionId, request.method !== "GET", token)
      : createSession(request, token);
  },
  dispose: (sessionId, request) => clearExistingSession(sessionId, request),
});
