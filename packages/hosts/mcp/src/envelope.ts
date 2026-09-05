import { isJSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Match, Predicate } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  defaultMcpResource,
  McpAuthProvider,
  McpErrorReporter,
  McpSessionStore,
  mcpResourceFromPathname,
  scopedMcpRoutePaths,
  type AuthOutcome,
  type McpDispatchResult,
  type McpResource,
} from "./seams";

// ---------------------------------------------------------------------------
// Provider-neutral MCP serving envelope.
//
// Routes:
//   GET <provider-declared discovery paths>  -> McpAuthProvider metadata
//   *   /mcp                                  -> authenticate -> dispatch(default)
//   *   /mcp/toolkits/:slug                   -> authenticate -> dispatch(toolkit)
//   *   /mcp/integrations/:slugs              -> authenticate -> dispatch(integrations)
//   *   /mcp/tools/:toolId                    -> authenticate -> dispatch(tool)
//
// The sub-resource grammar is owned by `mcpResourceFromPathname` in ./seams;
// the envelope registers the routes and parses the matched path with it.
//
// The provider DECLARES the discovery paths it owns (at least the protected-
// resource metadata document) via `McpAuthProvider.discoveryRoutes`; the
// envelope never hard-codes `/.well-known/oauth-*`. The OAuth endpoints
// (/authorize, /token, /register) stay OUT of the envelope: they are served by
// the provider's own handler (self-host: Better Auth at /api/auth; cloud:
// WorkOS, external). The envelope only needs the provider's discovery routes,
// resource-metadata URL, and authenticate.
//
// The envelope hard-codes ONLY the MCP serving paths and CORS. Everything else
// — every `/.well-known/*` path, the resource-metadata URL, the authn/authz
// semantics, and the entire session lifecycle (create + forward + ownership) —
// comes from the two seams.
//
// Runtime-agnostic: built on `effect/unstable/http` (HttpRouter), NO
// platform-bun. The `/mcp` flow is fully Effect; the streamable-HTTP transport
// works on web `Request`/`Response`, so the envelope reconstructs the inbound
// web request once, hands it to the store, and converts the store's `Response`
// into an Effect response while preserving both streaming bodies and outer
// metadata (the latter matters when the HTTP adapter strips a HEAD body).
// ---------------------------------------------------------------------------

const MCP_PATH = "/mcp";

/** The methods the streamable-HTTP transport accepts on `/mcp`. */
const ALLOWED_MCP_METHODS = new Set(["GET", "POST", "DELETE", "OPTIONS"]);

/**
 * Preserve a WHATWG response's status and headers on the Effect wrapper.
 *
 * Passing only `response` to `HttpServerResponse.raw` works for ordinary
 * requests because `toWeb` returns the nested Response verbatim. For HEAD,
 * however, the adapter intentionally omits the nested body and serializes the
 * outer wrapper instead; without copied metadata that becomes an empty 200
 * with no content type.
 */
const fromWebResponse = (response: Response): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.raw(response, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

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
  opts?: {
    readonly cors?: boolean;
    readonly challenge?: string;
    readonly retryAfterSeconds?: number;
    /**
     * The id to echo. Envelope-level errors have no request to answer and stay
     * at the default `null`; only an error that answers ONE identified JSON-RPC
     * request (the pre-initialize guard below) sets it, since a client matches
     * the response to its pending request by id.
     */
    readonly id?: string | number | null;
  },
): Response => {
  const cors = opts?.cors ?? true;
  const challenge = opts?.challenge;
  const retryAfterSeconds = opts?.retryAfterSeconds;
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: opts?.id ?? null }),
    {
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
        ...(retryAfterSeconds === undefined ? {} : { "retry-after": String(retryAfterSeconds) }),
      },
    },
  );
};

/**
 * Advertised on transient-auth 503s (`Unavailable` outcomes) so clients back
 * off before retrying. Short: upstream auth-infra blips (JWKS fetch, IdP
 * membership lookups) are typically sub-second.
 */
export const UNAVAILABLE_RETRY_AFTER_SECONDS = 2;

/** JSON-RPC's own code for "this server does not implement that method". */
const METHOD_NOT_FOUND = -32601;

/**
 * The transport's POST content negotiation, mirrored.
 *
 * `WebStandardStreamableHTTPServerTransport.handlePostRequest` refuses a POST
 * on its headers alone, BEFORE it reads the body:
 *
 *   - `Accept` must list BOTH `application/json` and `text/event-stream`, else
 *     406 Not Acceptable.
 *   - `Content-Type` must include `application/json`, else 415 Unsupported
 *     Media Type.
 *
 * The guard below answers 200 without ever consulting the transport, so it must
 * not fire on a request the transport would have refused — that would turn a
 * 406 or a 415 into a success. These are the SDK's own substring tests on the
 * raw header values, copied so the two agree; a request that fails either falls
 * through untouched and gets the transport's real 406/415.
 *
 * The transport's DNS-rebinding check runs earlier still, but it is inert
 * unless a host passes `enableDnsRebindingProtection`, which no host here does.
 */
const passesTransportContentNegotiation = (request: Request): boolean => {
  const accept = request.headers.get("accept");
  if (!accept?.includes("application/json") || !accept.includes("text/event-stream")) return false;
  const contentType = request.headers.get("content-type");
  return contentType !== null && contentType.includes("application/json");
};

/**
 * The pre-initialize dispatch guard, for the session-less POST every host
 * handles before it hands the request to a fresh streamable-HTTP transport.
 *
 * Only `initialize` can open a session, so the transport answers every OTHER
 * method with HTTP **400** + `-32000 Server not initialized`. A 400 is a
 * transport-level failure: clients tear the connection down rather than treat
 * it as one request failing. So a client that opens with an optional probe —
 * MCP 2026-07-28 clients lead with `server/discover` — is disconnected before
 * it can fall back to `initialize`, and the handshake never happens.
 *
 * JSON-RPC already has the right answer for a method the dispatcher doesn't
 * know: `-32601 Method not found`, carried on a normal HTTP 200. It is a
 * per-request error, so the connection survives and the client falls back.
 *
 * This deliberately covers ANY method other than `initialize` rather than
 * naming `server/discover`: pre-session, `initialize` is the only method this
 * dispatcher implements, so -32601 is the literal truth for the rest. It also
 * can't silently mask a future real `server/discover` — implementing it means
 * it stops being unknown here, instead of a special case going stale.
 *
 * The guard REPLACES one transport answer and must not shadow any of the
 * others, so it fires only where it is the whole story: a POST that clears the
 * transport's content negotiation AND carries a structurally valid JSON-RPC 2.0
 * request. Everything else succeeds with `null` and reaches the transport
 * untouched, keeping the transport's own response — a non-POST, a bad
 * `Accept`/`Content-Type` (406/415), unparseable JSON or a message that is not
 * a valid JSON-RPC request (400 parse error: a fractional id, a non-object
 * `params`, an unknown top-level field), a batch, a notification or a response
 * (no id to answer), and `initialize` itself.
 *
 * Structural validity is decided by the SDK's own `isJSONRPCRequest`, the exact
 * predicate behind the transport's `JSONRPCMessageSchema.parse`, rather than a
 * hand-rolled re-implementation that could drift from it.
 *
 * Reads a clone, leaving the caller's request body intact for the transport.
 */
export const preInitializeMethodNotFound = (request: Request): Effect.Effect<Response | null> =>
  request.method !== "POST" || !passesTransportContentNegotiation(request)
    ? Effect.succeed(null)
    : Effect.tryPromise({
        try: (): Promise<unknown> => request.clone().json(),
        catch: () => null,
      }).pipe(
        // A body we cannot read is simply not ours to answer; hand it on.
        Effect.orElseSucceed(() => null),
        Effect.map(renderPreInitializeMethodNotFound),
      );

/** The pure decision behind {@link preInitializeMethodNotFound}. */
const renderPreInitializeMethodNotFound = (body: unknown): Response | null => {
  if (!isJSONRPCRequest(body)) return null;
  if (body.method === "initialize") return null;
  // An INNER response like every other store/handler error body: the host's
  // outer envelope owns the CORS headers on the way out.
  return jsonRpcErrorBody(200, METHOD_NOT_FOUND, "Method not found", {
    cors: false,
    id: body.id,
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
    return fromWebResponse(response);
  });

/**
 * Render a non-`Authenticated` {@link AuthOutcome} to a web `Response`:
 *   Unauthorized -> 401 + RFC 9728 challenge (outcome's own, else a default
 *                   built from the provider's `resourceMetadataUrl`)
 *   Forbidden    -> 403 JSON-RPC (default code -32001)
 *   Unavailable  -> 503 JSON-RPC -32001 + Retry-After
 *
 * The transient 503 and the session-lifecycle 404 both use JSON-RPC code
 * -32001 (the shared "auth/session envelope error" code); clients discriminate
 * on the HTTP status, which is the contract — 503 means retry the SAME
 * session, 404 means the session id is dead and the client must reconnect.
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
    Match.tag("Unavailable", (u) =>
      jsonRpcErrorBody(503, -32001, u.message, {
        retryAfterSeconds: UNAVAILABLE_RETRY_AFTER_SECONDS,
      }),
    ),
    Match.exhaustive,
  );

/**
 * Render a non-`Response` {@link McpDispatchResult} discriminant. A dead
 * session answers by method: POST/DELETE keep the 404 that drives client
 * re-initialization; a standalone GET gets 405, which the v1 SDK reads as
 * "no SSE stream offered" and stops retrying — breaking pre-cutover
 * reconnect loops whose GET-404 path never re-initialized.
 */
const renderDispatchError = (lookup: "not-found" | "forbidden", method: string): Response => {
  if (lookup === "forbidden") {
    return jsonRpcResponse(403, -32003, "MCP session does not belong to the current bearer");
  }
  if (method === "GET") {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found" },
        id: null,
      }),
      { status: 405, headers: { "content-type": "application/json", allow: "POST, DELETE" } },
    );
  }
  return jsonRpcResponse(404, -32001, "Session not found");
};

/** Dispatch an MCP request through authenticate -> store.dispatch -> transport. */
const mcpDispatch = (resource: McpResource) =>
  Effect.gen(function* () {
    const httpRequest = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* McpAuthProvider;
    const store = yield* McpSessionStore;
    const request = yield* toWebRequest(httpRequest);

    // CORS preflight: answer before auth so unauthenticated clients can probe.
    if (request.method === "OPTIONS") {
      return fromWebResponse(corsPreflightResponse());
    }

    // Streamable-HTTP only defines GET/POST/DELETE on the endpoint. Any other
    // method (PUT/PATCH/…) is rejected with a JSON-RPC 405 BEFORE auth/dispatch —
    // otherwise it would fall through and spin up a session engine for a method
    // the transport can't serve.
    if (!ALLOWED_MCP_METHODS.has(request.method)) {
      return fromWebResponse(jsonRpcResponse(405, -32001, "Method not allowed"));
    }

    const sessionId = request.headers.get("mcp-session-id");

    // Authenticate (and, for session-aware providers, authorize) on EVERY
    // request. Non-authenticated outcomes render directly. Session teardown is
    // only safe after the store can validate the authenticated principal and MCP
    // resource; an auth-level Forbidden may not carry either.
    const outcome = yield* auth.authenticate(request);
    if (!Predicate.isTagged(outcome, "Authenticated")) {
      return fromWebResponse(renderAuthError(auth, request, outcome));
    }
    const principal = outcome.principal;

    // No session id: per the streamable-HTTP transport contract, only POST opens
    // a session. A GET needs an existing id (400); a DELETE on nothing is a
    // no-op (204). Both short-circuit BEFORE dispatch so the store never spins up
    // an engine for a bare GET/DELETE.
    if (!sessionId) {
      if (request.method === "GET") {
        return fromWebResponse(
          jsonRpcResponse(400, -32000, "mcp-session-id header required for SSE"),
        );
      }
      if (request.method === "DELETE") {
        return fromWebResponse(
          new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } }),
        );
      }
    }

    const result: McpDispatchResult = yield* store.dispatch({
      request,
      principal,
      resource,
      sessionId,
      method: request.method,
    });
    return fromWebResponse(
      result instanceof Response ? result : renderDispatchError(result, request.method),
    );
  });

/**
 * The `/mcp` route. Wraps {@link mcpDispatch} in a top-level `catchCause`: a
 * request-orchestration defect (a rejected cross-isolate RPC, a body-tee
 * failure, …) is reported to the optional {@link McpErrorReporter} (Sentry /
 * `ErrorCapture` parity — the provider's capture pipeline would never see it
 * otherwise, since the envelope returns a `Response`) and rendered as a stable
 * JSON-RPC 500 -32603 + CORS, rather than a bare platform 500 with no body.
 */
const mcpRoute = (resource: McpResource) =>
  mcpDispatch(resource).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const reporter = yield* McpErrorReporter;
        yield* reporter.report(cause);
        return fromWebResponse(jsonRpcResponse(500, -32603, "Internal server error"));
      }),
    ),
  );

// A scoped route re-parses the matched pathname through the shared grammar
// rather than reading route params, so the envelope and every host agree on
// exactly one definition of what `/mcp/<kind>/<value>` means.
const scopedMcpRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  // `request.url` is path-only under some adapters and absolute under others;
  // the base makes both parse and is otherwise discarded.
  const resource = mcpResourceFromPathname(new URL(request.url, "http://localhost").pathname);
  if (resource === null) {
    return fromWebResponse(jsonRpcResponse(404, -32001, "MCP resource not found"));
  }
  return yield* mcpRoute(resource);
});

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
        Effect.sync(() => fromWebResponse(corsPreflightResponse())),
      );
    }
    yield* router.add("*", MCP_PATH, mcpRoute(defaultMcpResource));
    for (const path of scopedMcpRoutePaths(MCP_PATH)) {
      yield* router.add("*", path, scopedMcpRoute);
    }
  }),
);

/**
 * The discovery-only subset of {@link McpServingRoutes}: the provider-declared
 * `/.well-known/oauth-*` GET routes plus their CORS preflight, and NOTHING on
 * `/mcp`. Requires only the {@link McpAuthProvider} seam, not {@link McpSessionStore}.
 *
 * For a host whose `/mcp` transport is served outside this envelope (the
 * Cloudflare Agent bridge intercepts `/mcp` before the app handler) but that
 * still needs to publish its OAuth metadata docs. Such a host wires the `auth`
 * seam without a `sessions` seam.
 */
export const McpDiscoveryRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* McpAuthProvider;
    for (const route of auth.discoveryRoutes) {
      yield* router.add("GET", route.path, discoveryRoute(route.handler));
      yield* router.add(
        "OPTIONS",
        route.path,
        Effect.sync(() => fromWebResponse(corsPreflightResponse())),
      );
    }
  }),
);
