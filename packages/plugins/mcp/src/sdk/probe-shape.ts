// ---------------------------------------------------------------------------
// MCP endpoint shape probe — decide whether an unknown HTTP endpoint is
// actually speaking MCP before we try to classify it as such.
//
// Background:
//
//   `discoverTools` (via the MCP SDK's StreamableHTTP / SSE transport)
//   fails for every non-MCP endpoint too — 200-with-HTML, 400-GraphQL,
//   404, etc. all surface as the same opaque transport error. We need
//   our own classifier that distinguishes "real MCP" from
//   "OAuth-protected non-MCP service" without relying on RFC 9728/8414
//   metadata, since (a) plenty of non-MCP APIs publish that metadata,
//   and (b) plenty of real MCP servers authenticate with static API
//   keys and publish no OAuth metadata at all (e.g. cubic.dev).
//
// The probe issues an unauth JSON-RPC `initialize` POST and accepts
// only the wire shapes a real MCP server can return:
//
//   - 2xx with `Content-Type: text/event-stream` — streamable HTTP
//     transport, body is an SSE stream we don't consume.
//   - 2xx with `Content-Type: application/json` whose body parses as a
//     JSON-RPC 2.0 envelope (`{jsonrpc:"2.0", result|error|method,...}`).
//   - 401 with `WWW-Authenticate: Bearer` AND a JSON-RPC error envelope
//     in the body. The body shape is what separates a real MCP server
//     from an unrelated OAuth-protected API: GraphQL/REST/HTML 401s
//     don't shape themselves as JSON-RPC.
//
// When POST returns 404/405/406/415 we retry with GET + `Accept:
// text/event-stream` to support legacy SSE-only servers; that path
// only accepts 2xx with `text/event-stream` or the same 401+Bearer
// shape.
//
// One `fetch` (occasionally two), no MCP-SDK session state, no OAuth
// round-trip, no DCR — every non-MCP endpoint exits here.
// ---------------------------------------------------------------------------

import { Data, Duration, Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

/** MCP initialize request body used as the shape probe. Any real MCP
 *  server either answers it (unauth-OK server) or returns the spec-
 *  mandated 401 + WWW-Authenticate pair. A non-MCP endpoint hit with
 *  this body will respond with whatever it does for unknown JSON
 *  payloads — 400, 404, HTML, a GraphQL error envelope, etc. — none of
 *  which match the gate below. */
const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "executor-probe", version: "0" },
  },
});

/** Header-name lookup is case-insensitive per RFC 7230. `fetch`'s
 *  `Response.headers` already lower-cases, but we normalise explicitly
 *  to stay robust against test mocks that construct `Headers` loosely. */
const readHeader = (headers: Readonly<Record<string, string>>, name: string): string | null => {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
};

class ProbeTransportError extends Data.TaggedError("ProbeTransportError")<{
  readonly reason: string;
  readonly cause: unknown;
}> {}

const decodeJsonString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const asObject = (body: string): Record<string, unknown> | null => {
  if (!body) return null;
  const parsed = decodeJsonString(body);
  if (Option.isNone(parsed)) return null;
  const value = parsed.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

/** Quick check that a body parses as a JSON-RPC 2.0 envelope. The MCP wire
 *  protocol is JSON-RPC 2.0, so a real MCP server's response to `initialize`
 *  (whether 2xx with the result, or a 401 error envelope) carries this
 *  shape. Non-MCP services don't — GraphQL APIs return `{errors:[...]}`,
 *  REST APIs return their own envelope, marketing pages return HTML. */
const isJsonRpcEnvelope = (body: string): boolean => {
  const obj = asObject(body);
  if (!obj) return false;
  if (obj.jsonrpc !== "2.0") return false;
  return "result" in obj || "error" in obj || "method" in obj;
};

/** Quick check that a body parses as an RFC 6750 OAuth Bearer error
 *  envelope (`{error: "invalid_token", error_description?: ..., ...}`).
 *  Real MCP servers like Atlassian return this shape on unauth requests
 *  even when their WWW-Authenticate omits `resource_metadata=`. The
 *  GraphQL `{errors: [...]}` envelope, which a non-MCP OAuth-protected
 *  GraphQL API would return, is explicitly excluded. */
const isOAuthErrorBody = (body: string): boolean => {
  const obj = asObject(body);
  if (!obj) return false;
  if (Array.isArray(obj.errors)) return false;
  return typeof obj.error === "string";
};

const ErrorMessageShape = Schema.Struct({ message: Schema.String });
const decodeErrorMessageShape = Schema.decodeUnknownOption(ErrorMessageShape);

const reasonFromBoundaryCause = (cause: unknown): string => {
  const messageShape = decodeErrorMessageShape(cause);
  if (Option.isSome(messageShape)) return messageShape.value.message;
  if (typeof cause === "string") return cause;
  if (typeof cause === "number" || typeof cause === "boolean" || typeof cause === "bigint") {
    return `${cause}`;
  }
  if (typeof cause === "symbol") return cause.description ?? "symbol";
  if (cause === null) return "null";
  if (typeof cause === "undefined") return "undefined";
  return "fetch failed";
};

/** Why the probe rejected an endpoint as not-MCP.
 *
 *  - `auth-required` — server returned 401. We don't know for sure it's
 *    an MCP server (no spec-compliant Bearer challenge or the body
 *    isn't JSON-RPC), but the right next step for the user is the same
 *    either way: provide credentials and retry. This is what
 *    misclassifies real MCP servers like cubic.dev (no
 *    resource_metadata) or ref.tools (no WWW-Authenticate at all)
 *    without the URL-token fallback at the detect layer.
 *  - `wrong-shape` — endpoint responded but with a body or status that
 *    doesn't match any MCP shape (200 HTML, 400 GraphQL, 404 from a
 *    static host, etc.). User action: this URL probably isn't MCP. */
export type McpProbeRejectCategory = "auth-required" | "wrong-shape";

export type McpShapeProbeResult =
  /** Server answered initialize successfully — either a 2xx with a
   *  JSON-RPC payload, or a 401 + WWW-Authenticate: Bearer (RFC 6750
   *  challenge) that the MCP auth spec requires. */
  | { readonly kind: "mcp"; readonly requiresAuth: boolean }
  /** Endpoint is reachable but the response does not look like MCP. */
  | {
      readonly kind: "not-mcp";
      readonly reason: string;
      readonly category: McpProbeRejectCategory;
    }
  /** Transport-level failure (DNS, TLS, timeout, abort, ...). */
  | { readonly kind: "unreachable"; readonly reason: string };

export interface ProbeOptions {
  /** Abort the request after this many ms. Default 8000. */
  readonly timeoutMs?: number;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly headers?: Record<string, string>;
  readonly queryParams?: Record<string, string>;
}

/**
 * Hit `endpoint` with a JSON-RPC `initialize` POST and classify the
 * response according to the MCP authorization spec.
 *
 * Returns `{kind: "mcp"}` only when the endpoint either:
 *   - answers with 2xx (unauth-OK MCP server), or
 *   - responds 401 with a `Bearer` WWW-Authenticate challenge.
 *
 * Anything else (400, 404, 200-with-HTML, 200-with-GraphQL-errors, ...)
 * is classified `not-mcp`. Transport errors surface as `unreachable`.
 */
export const probeMcpEndpointShape = (
  endpoint: string,
  options: ProbeOptions = {},
): Effect.Effect<McpShapeProbeResult> =>
  Effect.gen(function* () {
    const timeoutMs = options.timeoutMs ?? 8_000;
    const outcome = yield* Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;

      const readBody = (response: {
        readonly text: Effect.Effect<string, unknown>;
      }): Effect.Effect<string> =>
        response.text.pipe(
          Effect.timeout(Duration.millis(timeoutMs)),
          Effect.catch(() => Effect.succeed("")),
        );

      const classify = (
        response: {
          readonly status: number;
          readonly headers: Readonly<Record<string, string>>;
          readonly text: Effect.Effect<string, unknown>;
        },
        method: "GET" | "POST",
      ): Effect.Effect<McpShapeProbeResult | null> =>
        Effect.gen(function* () {
          const contentType = readHeader(response.headers, "content-type") ?? "";
          const isSse = /^\s*text\/event-stream\b/i.test(contentType);

          if (response.status === 401) {
            const wwwAuth = readHeader(response.headers, "www-authenticate");
            if (!wwwAuth || !/^\s*bearer\b/i.test(wwwAuth)) {
              return {
                kind: "not-mcp",
                category: "auth-required",
                reason: "401 without Bearer WWW-Authenticate — not an MCP auth challenge",
              } as const;
            }
            // Spec-compliant MCP signal: the auth spec mandates a
            // `resource_metadata=` attribute pointing at the server's
            // RFC 9728 document. Real OAuth-protected MCP servers
            // (sentry.dev, etc.) include it. This attribute is rare on
            // unrelated OAuth services and is the cleanest accept signal
            // we have when the 401 body is RFC 6750 OAuth-shape rather
            // than JSON-RPC.
            if (/(?:^|[\s,])resource_metadata\s*=/i.test(wwwAuth)) {
              return { kind: "mcp", requiresAuth: true } as const;
            }
            // Looser RFC 6750 §3.1 signal: the Bearer challenge carries
            // `error=` / `error_description=` auth-params. Real MCP
            // servers (Supabase, GitHub Copilot, Vercel, Neon, Tavily,
            // Replicate, ...) include this even when they omit
            // `resource_metadata=`. The body alone isn't enough for
            // those — Supabase, e.g., returns `{"message":"Unauthorized"}`
            // which is neither JSON-RPC nor RFC 6750. The `error=`
            // auth-param is the tiebreaker.
            if (/(?:^|[\s,])error\s*=/i.test(wwwAuth)) {
              return { kind: "mcp", requiresAuth: true } as const;
            }
            // SSE responses can't carry a JSON-RPC error envelope; accept the
            // Bearer challenge alone in that case (rare but spec-permissible).
            if (isSse) return { kind: "mcp", requiresAuth: true } as const;
            // Fallback for MCP servers whose 401 omits
            // `resource_metadata=`. Two body shapes count:
            //   - JSON-RPC error (cubic.dev: API-key auth, JSON-RPC
            //     errors end-to-end).
            //   - RFC 6750 OAuth Bearer error envelope `{error:
            //     "invalid_token", ...}` without GraphQL `{errors:[...]}`
            //     (Atlassian).
            // Non-MCP OAuth-protected services that issue bare Bearer
            // challenges (Railway-style GraphQL, etc.) return `errors`
            // arrays or other shapes that fail both checks.
            const body = yield* readBody(response);
            if (!isJsonRpcEnvelope(body) && !isOAuthErrorBody(body)) {
              return {
                kind: "not-mcp",
                category: "auth-required",
                reason:
                  "401 + Bearer without resource_metadata, JSON-RPC body, or OAuth error body",
              } as const;
            }
            return { kind: "mcp", requiresAuth: true } as const;
          }

          if (response.status >= 200 && response.status < 300) {
            if (method === "GET") {
              if (!isSse) {
                return {
                  kind: "not-mcp",
                  category: "wrong-shape",
                  reason: "GET response is not an SSE stream",
                } as const;
              }
              return { kind: "mcp", requiresAuth: false } as const;
            }
            // POST 2xx: SSE body is opaque to us; otherwise require a
            // JSON-RPC envelope so we don't accept HTML/REST 200 responses.
            if (isSse) return { kind: "mcp", requiresAuth: false } as const;
            const body = yield* readBody(response);
            if (!isJsonRpcEnvelope(body)) {
              return {
                kind: "not-mcp",
                category: "wrong-shape",
                reason: "2xx POST body is not a JSON-RPC envelope",
              } as const;
            }
            return { kind: "mcp", requiresAuth: false } as const;
          }

          return null;
        });

      const url = new URL(endpoint);
      for (const [key, value] of Object.entries(options.queryParams ?? {})) {
        url.searchParams.set(key, value);
      }

      let postRequest = HttpClientRequest.post(url.toString()).pipe(
        HttpClientRequest.setHeader("content-type", "application/json"),
        HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
        HttpClientRequest.bodyText(INITIALIZE_BODY, "application/json"),
      );
      for (const [name, value] of Object.entries(options.headers ?? {})) {
        postRequest = HttpClientRequest.setHeader(postRequest, name, value);
      }

      const postResponse = yield* client
        .execute(postRequest)
        .pipe(Effect.timeout(Duration.millis(timeoutMs)));

      const postResult = yield* classify(postResponse, "POST");
      if (postResult) return postResult;

      if ([404, 405, 406, 415].includes(postResponse.status)) {
        let getRequest = HttpClientRequest.get(url.toString()).pipe(
          HttpClientRequest.setHeader("accept", "text/event-stream"),
        );
        for (const [name, value] of Object.entries(options.headers ?? {})) {
          getRequest = HttpClientRequest.setHeader(getRequest, name, value);
        }
        const getResponse = yield* client
          .execute(getRequest)
          .pipe(Effect.timeout(Duration.millis(timeoutMs)));
        const getResult = yield* classify(getResponse, "GET");
        if (getResult) return getResult;
      }

      return {
        kind: "not-mcp",
        category: "wrong-shape",
        reason: `unexpected status ${postResponse.status} for initialize`,
      } as const;
    }).pipe(
      Effect.provide(options.httpClientLayer ?? FetchHttpClient.layer),
      Effect.mapError(
        (cause) =>
          new ProbeTransportError({
            reason: reasonFromBoundaryCause(cause),
            cause,
          }),
      ),
      Effect.catch((cause) =>
        Effect.succeed<McpShapeProbeResult>({
          kind: "unreachable",
          reason: cause.reason,
        }),
      ),
    );

    return outcome;
  }).pipe(Effect.withSpan("mcp.plugin.probe_shape"));
