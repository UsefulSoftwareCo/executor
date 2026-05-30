import { Effect, Match, Predicate } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  McpAuthProvider,
  McpErrorReporter,
  McpSessionStore,
  type AuthOutcome,
  type McpDispatchResult,
} from "./seams";

// ---------------------------------------------------------------------------
// Provider-neutral MCP serving envelope.
//
// Routes:
//   GET <provider-declared discovery paths>  -> McpAuthProvider metadata
//   *   /mcp                                  -> authenticate -> dispatch
//
// The provider DECLARES the discovery paths it owns (at least the protected-
// resource metadata document) via `McpAuthProvider.discoveryRoutes`; the
// envelope never hard-codes `/.well-known/oauth-*`. The OAuth endpoints
// (/authorize, /token, /register) stay OUT of the envelope: they are served by
// the provider's own handler (self-host: Better Auth at /api/auth; cloud:
// WorkOS, external). The envelope only needs the provider's discovery routes,
// resource-metadata URL, and authenticate.
//
// The envelope hard-codes ONLY the `/mcp` path and CORS. Everything else —
// every `/.well-known/*` path, the resource-metadata URL, the authn/authz
// semantics, and the entire session lifecycle (create + forward + ownership) —
// comes from the two seams.
//
// Runtime-agnostic: built on `effect/unstable/http` (HttpRouter), NO
// platform-bun. The `/mcp` flow is fully Effect; the streamable-HTTP transport
// works on web `Request`/`Response`, so the envelope reconstructs the inbound
// web request once, hands it to the store, and wraps the store's `Response`
// with `HttpServerResponse.raw` (which passes a `Response` body through
// unchanged, preserving streaming SSE bodies).
// ---------------------------------------------------------------------------

const MCP_PATH = "/mcp";

/** The methods the streamable-HTTP transport accepts on `/mcp`. */
const ALLOWED_MCP_METHODS = new Set(["GET", "POST", "DELETE", "OPTIONS"]);

/**
 * The canonical CORS preflight `Response` (204) answered for an `OPTIONS` on
 * `/mcp` AND on every provider-declared discovery path. A browser issues a
 * preflight against the metadata docs too (RFC 9728 discovery from a 401), so
 * the envelope answers OPTIONS for those paths, not only `/mcp`.
 */
const corsPreflightResponse = (): Response =>
  new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers":
        "content-type, authorization, mcp-session-id, accept, mcp-protocol-version",
      "access-control-expose-headers": "mcp-session-id, WWW-Authenticate",
    },
  });

/**
 * The canonical JSON-RPC error `Response` builder for every MCP serving site.
 *
 * Emits the EXACT body every host renders — `{jsonrpc:"2.0",error:{code,message},
 * id:null}` — with `content-type: application/json`. Two header policies:
 *
 *   - `cors: true` (default) adds `access-control-allow-origin: *`. This is the
 *     envelope's policy and the cloud edge worker's (`jsonRpcWebResponse`):
 *     errors cross the browser boundary, so they carry CORS. A `challenge`
 *     additionally emits the `WWW-Authenticate` header + exposes it via CORS
 *     (the 401 path).
 *   - `cors: false` omits CORS entirely — for INNER responses that never reach
 *     the browser directly (the cloud Durable Object and the self-host /local
 *     in-process stores, whose `Response` is post-processed / re-wrapped with
 *     CORS by the outer envelope before it leaves the origin).
 *
 * One renderer, byte-identical bodies across host-mcp + cloud + self-host +
 * local — the four hand-rolled copies are deleted in favor of this.
 */
export const jsonRpcErrorBody = (
  status: number,
  code: number,
  message: string,
  opts?: { readonly cors?: boolean; readonly challenge?: string },
): Response => {
  const cors = opts?.cors ?? true;
  const challenge = opts?.challenge;
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: {
      "content-type": "application/json",
      ...(cors ? { "access-control-allow-origin": "*" } : {}),
      ...(challenge
        ? {
            "www-authenticate": challenge,
            "access-control-expose-headers": "WWW-Authenticate",
          }
        : {}),
    },
  });
};

/** The envelope's own CORS-on JSON-RPC error `Response`, optionally carrying a challenge. */
const jsonRpcResponse = (
  status: number,
  code: number,
  message: string,
  challenge?: string,
): Response =>
  challenge === undefined
    ? jsonRpcErrorBody(status, code, message)
    : jsonRpcErrorBody(status, code, message, { challenge });

/**
 * Reconstruct a WHATWG `Request` from the Effect HTTP request. Prefer the
 * underlying source `Request` (preserves the body stream the transport reads);
 * otherwise rebuild from parts. A failed body read is a defect here, not a
 * recoverable error.
 */
const toWebRequest = (req: HttpServerRequest.HttpServerRequest): Effect.Effect<Request> =>
  Effect.gen(function* () {
    if (req.source instanceof Request) return req.source;
    const headers = new Headers(req.headers as Record<string, string>);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: rebuilding a web Request from a non-web source; a failed body read is an unrecoverable infra defect, not a domain error
    const body = hasBody ? yield* req.text.pipe(Effect.orDie) : undefined;
    return new Request(req.url, { method: req.method, headers, body });
  });

/** Serve a provider discovery document, wrapping its web `Response`. */
const discoveryRoute = (handler: (request: Request) => Effect.Effect<Response>) =>
  Effect.gen(function* () {
    const httpRequest = yield* HttpServerRequest.HttpServerRequest;
    const request = yield* toWebRequest(httpRequest);
    const response = yield* handler(request);
    return HttpServerResponse.raw(response);
  });

/**
 * Render a non-`Authenticated` {@link AuthOutcome} to a web `Response`:
 *   Unauthorized -> 401 + RFC 9728 challenge (outcome's own, else a default
 *                   built from the provider's `resourceMetadataUrl`)
 *   Forbidden    -> 403 JSON-RPC (default code -32001)
 *   Unavailable  -> 503 JSON-RPC -32001
 */
const renderAuthError = (
  auth: McpAuthProvider["Service"],
  request: Request,
  outcome: Exclude<AuthOutcome, { readonly _tag: "Authenticated" }>,
): Response =>
  Match.value(outcome).pipe(
    Match.tag("Unauthorized", (u) =>
      jsonRpcResponse(
        401,
        -32001,
        "Unauthorized",
        u.challenge ?? `Bearer resource_metadata="${auth.resourceMetadataUrl(request)}"`,
      ),
    ),
    Match.tag("Forbidden", (f) => jsonRpcResponse(403, f.code ?? -32001, f.message)),
    Match.tag("Unavailable", (u) => jsonRpcResponse(503, -32001, u.message)),
    Match.exhaustive,
  );

/** Render a non-`Response` {@link McpDispatchResult} discriminant. */
const renderDispatchError = (lookup: "not-found" | "forbidden"): Response =>
  lookup === "not-found"
    ? jsonRpcResponse(404, -32001, "Session not found")
    : jsonRpcResponse(403, -32003, "MCP session does not belong to the current bearer");

/** Dispatch a `/mcp` request through authenticate -> store.dispatch -> transport. */
const mcpDispatch = Effect.gen(function* () {
  const httpRequest = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* McpAuthProvider;
  const store = yield* McpSessionStore;
  const request = yield* toWebRequest(httpRequest);

  // CORS preflight: answer before auth so unauthenticated clients can probe.
  if (request.method === "OPTIONS") {
    return HttpServerResponse.raw(corsPreflightResponse());
  }

  // Streamable-HTTP only defines GET/POST/DELETE on the endpoint. Any other
  // method (PUT/PATCH/…) is rejected with a JSON-RPC 405 BEFORE auth/dispatch —
  // otherwise it would fall through and spin up a session engine for a method
  // the transport can't serve.
  if (!ALLOWED_MCP_METHODS.has(request.method)) {
    return HttpServerResponse.raw(jsonRpcResponse(405, -32001, "Method not allowed"));
  }

  const sessionId = request.headers.get("mcp-session-id");

  // Authenticate (and, for session-aware providers, authorize) on EVERY
  // request. On a non-Authenticated outcome:
  //   - Forbidden  -> dispose the live session first (cloud tears down a DO
  //                   whose org access was revoked), then render the 403. The
  //                   inbound request is forwarded so the store can propagate
  //                   the request's W3C trace context onto the teardown RPC.
  //   - other      -> render directly.
  const outcome = yield* auth.authenticate(request);
  if (!Predicate.isTagged(outcome, "Authenticated")) {
    if (Predicate.isTagged(outcome, "Forbidden") && sessionId) {
      yield* store.dispose(sessionId, request);
    }
    return HttpServerResponse.raw(renderAuthError(auth, request, outcome));
  }
  const principal = outcome.principal;

  // No session id: per the streamable-HTTP transport contract, only POST opens
  // a session. A GET needs an existing id (400); a DELETE on nothing is a
  // no-op (204). Both short-circuit BEFORE dispatch so the store never spins up
  // an engine for a bare GET/DELETE.
  if (!sessionId) {
    if (request.method === "GET") {
      return HttpServerResponse.raw(
        jsonRpcResponse(400, -32000, "mcp-session-id header required for SSE"),
      );
    }
    if (request.method === "DELETE") {
      return HttpServerResponse.raw(
        new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } }),
      );
    }
  }

  const result: McpDispatchResult = yield* store.dispatch({
    request,
    principal,
    sessionId,
    method: request.method,
  });
  return HttpServerResponse.raw(result instanceof Response ? result : renderDispatchError(result));
});

/**
 * The `/mcp` route. Wraps {@link mcpDispatch} in a top-level `catchCause`: a
 * request-orchestration defect (a rejected cross-isolate RPC, a body-tee
 * failure, …) is reported to the optional {@link McpErrorReporter} (Sentry /
 * `ErrorCapture` parity — the provider's capture pipeline would never see it
 * otherwise, since the envelope returns a `Response`) and rendered as a stable
 * JSON-RPC 500 -32603 + CORS, rather than a bare platform 500 with no body.
 */
const mcpRoute = mcpDispatch.pipe(
  Effect.catchCause((cause) =>
    Effect.gen(function* () {
      const reporter = yield* McpErrorReporter;
      yield* reporter.report(cause);
      return HttpServerResponse.raw(jsonRpcResponse(500, -32603, "Internal server error"));
    }),
  ),
);

/**
 * The shared MCP serving routes, as an `HttpRouter.use` Layer. A host merges
 * this with its other routes and provides the two seam Layers + the HTTP
 * platform services. Provider-neutral: cloud adopts the same Layer next.
 *
 * The discovery `GET` routes come from `McpAuthProvider.discoveryRoutes`, so
 * the provider — not the envelope — owns its `/.well-known/oauth-*` paths. An
 * `OPTIONS` on each discovery path answers the same CORS preflight as `/mcp`
 * (a browser preflights the metadata docs during RFC 9728 discovery).
 */
export const McpServingRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* McpAuthProvider;
    for (const route of auth.discoveryRoutes) {
      yield* router.add("GET", route.path, discoveryRoute(route.handler));
      yield* router.add(
        "OPTIONS",
        route.path,
        Effect.sync(() => HttpServerResponse.raw(corsPreflightResponse())),
      );
    }
    yield* router.add("*", MCP_PATH, mcpRoute);
  }),
);
