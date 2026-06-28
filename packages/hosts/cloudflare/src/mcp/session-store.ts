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

import { Data, Effect, Layer, Schedule } from "effect";

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

// ---------------------------------------------------------------------------
// Transient DO-relocation retry.
//
// Cloudflare may relocate a live Durable Object between machines; an in-flight
// stub call against the now-stale instance throws "cannot access storage
// because object has moved to a different machine". The runtime throws this
// BEFORE the object touched storage, so no work and no writes happened on that
// instance — a re-issued stub call resolves the DO's new location and succeeds.
// (Observed in prod 2026-06-15: a single `mcp.do.init` failure surfaced to the
// client as a -32603 "Internal server error" that a reconnect cleared.)
//
// We retry ONLY this relocation class, and ONLY `init` — init takes a
// structured `meta` object with no request body, so replaying it is safe. The
// forward path (`handleRequest`) is deliberately excluded: its `Request` body is
// a one-shot stream that cannot be re-sent on a retry without buffering.
// ---------------------------------------------------------------------------

const RELOCATED_DO_ERROR_FRAGMENT = "moved to a different machine";

/** A rejected DO stub call, normalized at the boundary: the original thrown
 *  value in `cause` (so the final `Effect.die` re-raises it verbatim) plus a
 *  pre-computed `relocated` flag so the retry gate never re-inspects `unknown`. */
class DoStubError extends Data.TaggedError("DoStubError")<{
  readonly cause: unknown;
  readonly relocated: boolean;
}> {}

/** Normalize a rejected DO stub call, flagging the Cloudflare relocation class —
 *  the only safe-to-retry error, and detectable only via the thrown message. */
const toDoStubError = (cause: unknown): DoStubError =>
  new DoStubError({
    cause,
    // oxlint-disable-next-line executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: Cloudflare signals DO relocation only via the thrown Error's message
    relocated: cause instanceof Error && cause.message.includes(RELOCATED_DO_ERROR_FRAGMENT),
  });

/** Up to 4 attempts total (1 + 3 retries) at ~25/50/100ms jittered backoff. */
export const DO_RELOCATION_MAX_RETRIES = 3;
const DO_RELOCATION_RETRY_SCHEDULE = Schedule.jittered(Schedule.exponential("25 millis"));

/**
 * Run a replayable DO stub call under one `withSpan`, retrying the DO-relocation
 * error a bounded number of times. A call that still fails after retries (or any
 * non-relocation rejection) becomes an unrecoverable defect — exactly the prior
 * `Effect.promise` semantics, which the envelope's top-level `catchCause` renders
 * as a -32603 and reports to the error reporter (cloud: Sentry).
 */
const withDoRelocationRetry = <A>(
  spanName: string,
  attributes: Record<string, string | number | boolean>,
  call: () => Promise<A>,
): Effect.Effect<A> =>
  Effect.suspend(() => {
    let attempts = 0;
    return Effect.tryPromise({
      try: () => {
        attempts += 1;
        return call();
      },
      catch: toDoStubError,
    }).pipe(
      // Gate retries on BOTH the relocation class and a hard attempt budget. The
      // `attempts` counter (bumped in `try`) bounds this directly rather than via
      // `retry`'s `times`, whose interaction with `while` is unreliable here.
      Effect.retry({
        schedule: DO_RELOCATION_RETRY_SCHEDULE,
        while: (error) => error.relocated && attempts <= DO_RELOCATION_MAX_RETRIES,
      }),
      Effect.tap(() =>
        attempts > 1
          ? Effect.annotateCurrentSpan({ "mcp.do.relocation_retries": attempts - 1 })
          : Effect.void,
      ),
      // A call that still fails (or any non-relocation rejection) re-raises the
      // original thrown value as an unrecoverable defect — the prior
      // `Effect.promise` semantics the envelope renders as a -32603.
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: dispatch's contract is E=never; an exhausted DO RPC re-raises as the defect the envelope renders as -32603
      Effect.catch((error) => Effect.die(error.cause)),
    );
  }).pipe(Effect.withSpan(spanName, { attributes }));

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
  resource: McpDispatchInput["resource"],
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const stub = config.getStub(sessionId);
    const propagation = yield* currentPropagationHeaders(request);
    const propagated = withPropagationHeaders(
      withVerifiedIdentityHeaders(request, token, resource),
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
  resource: McpDispatchInput["resource"],
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const stub = config.newStub();
    const propagation = yield* currentPropagationHeaders(request);
    yield* withDoRelocationRetry("mcp.do.init", { "mcp.request.session_id_present": false }, () =>
      stub.init(
        {
          organizationId: token.organizationId,
          userId: token.accountId,
          resource,
          elicitationMode: readElicitationMode(request),
          // The public origin the client reached us at — lets the DO derive a web
          // base URL with no static config (we read the real URL, not a spoofable
          // forwarded host).
          webOrigin: new URL(request.url).origin,
        },
        propagation,
      ),
    );
    const propagated = withPropagationHeaders(
      withVerifiedIdentityHeaders(request, token, resource),
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
      resource,
      sessionId,
    }: McpDispatchInput): Effect.Effect<McpDispatchResult> => {
      const token: VerifiedTokenHeaders = {
        accountId: principal.accountId,
        organizationId: principal.organizationId,
      };
      return sessionId
        ? forwardToExistingSession(
            config,
            request,
            sessionId,
            request.method !== "GET",
            token,
            resource,
          )
        : createSession(config, request, token, resource);
    },
    dispose: (sessionId, request) => clearExistingSession(config, sessionId, request),
  });
