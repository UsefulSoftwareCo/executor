// ---------------------------------------------------------------------------
// Cloud MCP handler — Effect-native HTTP app for /mcp + /.well-known/*
// ---------------------------------------------------------------------------
//
// Built on Effect v4's unstable HTTP `HttpEffect.toWebHandler`. start.ts's
// mcpRequestMiddleware calls `mcpFetch` and falls through to `next()` when it
// returns `null` (non-MCP path) so TanStack Start keeps routing.
//
// Streaming passthrough — the MCP session Durable Object returns a `Response`
// whose body is a `ReadableStream` (SSE). We wrap that `Response` in
// `HttpServerResponse.raw(response)`; the platform's `toWeb` conversion
// recognises `body.body instanceof Response` and returns it as-is (only
// merging headers we set on the outer response, which is none), so the
// underlying `ReadableStream` passes through untouched.
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Cause, Context, Effect, Layer, Option, Predicate, Result, Schema } from "effect";

import { createCachedRemoteJWKSet } from "./jwks-cache";
import { captureCause } from "./observability";
import { TelemetryLive } from "./services/telemetry";
import {
  McpJwtVerificationError,
  verifyWorkOSMcpAccessToken,
  type VerifiedToken,
} from "./mcp-auth";
import { ApiKeyService } from "./auth/api-keys";
import { authorizeOrganization } from "./auth/authorize-organization";
import { UserStoreService } from "./auth/context";
import { CoreSharedServices } from "./api/core-shared-services";
import { DbService } from "./services/db";
import { peekAndAnnotate } from "./mcp/response-peek";
import {
  authTemporarilyUnavailable,
  CORS_ALLOW_ORIGIN,
  jsonResponse,
  jsonRpcError,
  unauthorized,
} from "./mcp/responses";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTHKIT_DOMAIN = env.MCP_AUTHKIT_DOMAIN ?? "https://signin.executor.sh";
const RESOURCE_ORIGIN = env.MCP_RESOURCE_ORIGIN ?? "https://executor.sh";
const WORKOS_CLIENT_ID = env.WORKOS_CLIENT_ID;

// Module-scope cache survives across MCP requests within the same worker
// isolate. AuthKit's JWKS rotates on the order of hours/days, so a 1h TTL
// dominates the upstream cooldown without sacrificing rotation safety —
// `createCachedRemoteJWKSet` force-refreshes on key-not-found inside its
// resolver. Production telemetry showed ~222 fetches/8h with p99 1.7s on
// the previous default-cooldown setup; this collapses that to ~1 per
// isolate-hour.
const jwks = createCachedRemoteJWKSet(new URL(`${AUTHKIT_DOMAIN}/oauth2/jwks`));

const BEARER_PREFIX = "Bearer ";
const INTERNAL_ACCOUNT_ID_HEADER = "x-executor-mcp-account-id";
const INTERNAL_ORGANIZATION_ID_HEADER = "x-executor-mcp-organization-id";

const CORS_PREFLIGHT_HEADERS = {
  ...CORS_ALLOW_ORIGIN,
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, mcp-session-id, accept, mcp-protocol-version",
  "access-control-expose-headers": "mcp-session-id",
} as const;

const MCP_PATH = "/mcp";
const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";
const PROTECTED_RESOURCE_METADATA_URL = `${RESOURCE_ORIGIN}${PROTECTED_RESOURCE_METADATA_PATH}`;
const RESOURCE_URL = `${RESOURCE_ORIGIN}${MCP_PATH}`;

type McpUnauthorizedReason = "missing_bearer" | "invalid_token";

type McpAuthorizedResult = {
  readonly _tag: "Authorized";
  readonly token: VerifiedToken;
};

type McpUnauthorizedResult = {
  readonly _tag: "Unauthorized";
  readonly reason: McpUnauthorizedReason;
  readonly description?: string;
};

export type McpAuthResult = McpAuthorizedResult | McpUnauthorizedResult;

export const mcpAuthorized = (token: VerifiedToken): McpAuthorizedResult => ({
  _tag: "Authorized",
  token,
});

export const mcpUnauthorized = (
  reason: McpUnauthorizedReason,
  description?: string,
): McpUnauthorizedResult => ({
  _tag: "Unauthorized",
  reason,
  description,
});

const corsPreflight = HttpServerResponse.empty({
  status: 204,
  headers: CORS_PREFLIGHT_HEADERS,
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export class McpAuth extends Context.Service<
  McpAuth,
  {
    readonly verifyBearer: (
      request: Request,
    ) => Effect.Effect<McpAuthResult, McpJwtVerificationError>;
  }
>()("@executor-js/cloud/McpAuth") {}

export class McpOrganizationAuth extends Context.Service<
  McpOrganizationAuth,
  {
    readonly authorize: (
      accountId: string,
      organizationId: string,
    ) => Effect.Effect<boolean, unknown>;
  }
>()("@executor-js/cloud/McpOrganizationAuth") {}

const verifyJwt = (token: string) =>
  verifyWorkOSMcpAccessToken(token, jwks, {
    issuer: AUTHKIT_DOMAIN,
    audience: WORKOS_CLIENT_ID,
  });

const DbLive = DbService.Live;
const UserStoreLive = UserStoreService.Live.pipe(Layer.provide(DbLive));
const McpOrganizationAuthServices = Layer.mergeAll(DbLive, UserStoreLive, CoreSharedServices);

export const McpOrganizationAuthLive = Layer.succeed(McpOrganizationAuth)({
  authorize: (accountId, organizationId) =>
    authorizeOrganization(accountId, organizationId).pipe(
      Effect.map((org) => org !== null),
      Effect.provide(McpOrganizationAuthServices),
    ),
});

const looksLikeJwt = (token: string): boolean => token.split(".").length === 3;

export const McpAuthLive = Layer.effect(
  McpAuth,
  Effect.gen(function* () {
    const apiKeys = yield* ApiKeyService;

    const verifyApiKey = Effect.fn("mcp.auth.verify_api_key")(function* (token: string) {
      const principal = yield* apiKeys.validate(token).pipe(
        Effect.catchTag("ApiKeyValidationError", (error) =>
          Effect.fail(
            new McpJwtVerificationError({
              cause: error.cause,
              reason: "system",
            }),
          ),
        ),
      );
      if (!principal) {
        yield* Effect.annotateCurrentSpan({
          "mcp.auth.outcome": "invalid",
          "mcp.auth.invalid_reason": "api_key",
        });
        return mcpUnauthorized("invalid_token", "The API key is invalid");
      }

      yield* Effect.annotateCurrentSpan({
        "mcp.auth.outcome": "verified",
        "mcp.auth.credential_type": "api_key",
        "mcp.auth.has_organization": true,
      });
      return mcpAuthorized({
        accountId: principal.accountId,
        organizationId: principal.organizationId,
      });
    });

    const verifyJwtBearer = Effect.fn("mcp.auth.verify_jwt_bearer")(function* (token: string) {
      const verified = yield* verifyJwt(token).pipe(
        Effect.catchTag("McpJwtVerificationError", (error) => {
          if (error.reason === "system") return Effect.fail(error);
          return Effect.gen(function* () {
            yield* Effect.annotateCurrentSpan({
              "mcp.auth.outcome": "invalid",
              "mcp.auth.invalid_reason": error.reason,
            });
            return mcpUnauthorized(
              "invalid_token",
              error.reason === "expired"
                ? "The access token expired"
                : "The access token is invalid",
            );
          });
        }),
      );
      if (!verified) return mcpUnauthorized("invalid_token", "The access token is invalid");
      if (Predicate.isTagged(verified, "Unauthorized")) return verified;
      if (!verified.accountId) {
        yield* Effect.annotateCurrentSpan({ "mcp.auth.outcome": "missing_subject" });
        return mcpUnauthorized("invalid_token", "The access token is invalid");
      }
      yield* Effect.annotateCurrentSpan({
        "mcp.auth.outcome": "verified",
        "mcp.auth.credential_type": "jwt",
        "mcp.auth.has_organization": !!verified.organizationId,
      });
      return mcpAuthorized(verified);
    });

    return {
      verifyBearer: Effect.fn("mcp.auth.verify_bearer")(function* (request) {
        const authHeader = request.headers.get("authorization");
        if (!authHeader?.startsWith(BEARER_PREFIX)) {
          yield* Effect.annotateCurrentSpan({ "mcp.auth.outcome": "missing_bearer" });
          return mcpUnauthorized("missing_bearer");
        }
        const token = authHeader.slice(BEARER_PREFIX.length).trim();
        if (!token) return mcpUnauthorized("invalid_token", "The bearer token is invalid");
        return yield* looksLikeJwt(token) ? verifyJwtBearer(token) : verifyApiKey(token);
      }),
    };
  }),
);

// ---------------------------------------------------------------------------
// Client fingerprint capture
// ---------------------------------------------------------------------------
// Annotates the Effect span with everything we can learn about a connecting MCP client: the
// parsed JSON-RPC body, whitelisted request headers, CF request metadata,
// and verified-JWT claims. Lets us compare how each client (Claude Code,
// Claude.ai web, ChatGPT, custom scripts, ...) actually reports over the
// wire. Runs before dispatch so unauthorized requests still get fingerprinted.
// ---------------------------------------------------------------------------

type CfRequestMetadata = {
  country?: string;
  city?: string;
  region?: string;
  timezone?: string;
  asn?: number;
  asOrganization?: string;
  tlsVersion?: string;
  tlsCipher?: string;
  httpProtocol?: string;
  colo?: string;
};

const requestWithCf = (request: Request): Request & { cf?: CfRequestMetadata } =>
  request as Request & { cf?: CfRequestMetadata };

const getCfMeta = (request: Request): CfRequestMetadata => requestWithCf(request).cf ?? {};

const HEADERS_TO_DUMP = [
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "content-type",
  "mcp-protocol-version",
  "origin",
  "referer",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "user-agent",
  "x-client-name",
  "x-client-version",
  "x-requested-with",
] as const;

const dumpHeaders = (request: Request): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of HEADERS_TO_DUMP) {
    const value = request.headers.get(name);
    if (value !== null) out[`mcp.http.header.${name}`] = value;
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    out["mcp.http.header.authorization.scheme"] = authHeader.split(" ", 1)[0] ?? "";
    out["mcp.http.header.authorization.length"] = String(authHeader.length);
  }
  // Record the full header name list too — surfaces anything unexpected
  // without us having to enumerate every possibility up front.
  out["mcp.http.header.names"] = Array.from(request.headers.keys()).sort().join(",");
  return out;
};

// JSON-RPC shapes — narrow to just the fields we fingerprint. Using Schema
// collapses the typeof-guard pile and surfaces "what does an MCP client
// actually send us" as declarative types. Unknown/malformed input decodes
// to None and contributes no span attrs.

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);

const JsonRpcEnvelope = Schema.Struct({
  method: Schema.optional(Schema.String),
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  params: Schema.optional(UnknownRecord),
  // Responses to server-initiated requests arrive as POST bodies too —
  // notably elicitation replies (`result.action = "accept" | "decline" | "cancel"`).
  result: Schema.optional(UnknownRecord),
});
type JsonRpcEnvelope = typeof JsonRpcEnvelope.Type;

const ElicitationReplyResult = Schema.Struct({
  action: Schema.optional(Schema.Literals(["accept", "decline", "cancel"])),
});

const InitializeParams = Schema.Struct({
  protocolVersion: Schema.optional(Schema.String),
  clientInfo: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      version: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
    }),
  ),
  capabilities: Schema.optional(UnknownRecord),
});

const NamedParams = Schema.Struct({ name: Schema.optional(Schema.String) });
const UriParams = Schema.Struct({ uri: Schema.optional(Schema.String) });

const decodeJsonRpcEnvelopeString = Schema.decodeUnknownOption(
  Schema.fromJsonString(JsonRpcEnvelope),
);
const decodeInitializeParams = Schema.decodeUnknownOption(InitializeParams);
const decodeNamedParams = Schema.decodeUnknownOption(NamedParams);
const decodeUriParams = Schema.decodeUnknownOption(UriParams);
const decodeElicitationReplyResult = Schema.decodeUnknownOption(ElicitationReplyResult);

const isMcpAuthorized = (value: McpAuthResult): value is McpAuthorizedResult =>
  Predicate.isTagged(value, "Authorized");
const isMcpUnauthorized = (value: McpAuthResult): value is McpUnauthorizedResult =>
  Predicate.isTagged(value, "Unauthorized");

const readJsonRpcEnvelope = (request: Request): Effect.Effect<Option.Option<JsonRpcEnvelope>> =>
  Effect.tryPromise({
    try: () => request.clone().text(),
    catch: () => undefined,
  }).pipe(
    Effect.map((text) => (text ? decodeJsonRpcEnvelopeString(text) : Option.none())),
    Effect.catchCause(() => Effect.succeed(Option.none())),
    Effect.withSpan("mcp.request.read_json_rpc"),
  );

const methodAttrs = (envelope: JsonRpcEnvelope): Record<string, unknown> => {
  const params = envelope.params ?? {};
  switch (envelope.method) {
    case "initialize":
      return Option.match(decodeInitializeParams(params), {
        onNone: () => ({}),
        onSome: (init) => ({
          ...(init.protocolVersion && { "mcp.client.protocol_version": init.protocolVersion }),
          ...(init.clientInfo?.name && { "mcp.client.name": init.clientInfo.name }),
          ...(init.clientInfo?.version && { "mcp.client.version": init.clientInfo.version }),
          ...(init.clientInfo?.title && { "mcp.client.title": init.clientInfo.title }),
          "mcp.client.capability.keys": Object.keys(init.capabilities ?? {})
            .sort()
            .join(","),
        }),
      });
    case "tools/call":
      return Option.match(decodeNamedParams(params), {
        onNone: () => ({}),
        onSome: ({ name }) => (name ? { "mcp.tool.name": name } : {}),
      });
    case "resources/read":
    case "resources/subscribe":
      return Option.match(decodeUriParams(params), {
        onNone: () => ({}),
        onSome: ({ uri }) => (uri ? { "mcp.resource.uri": uri } : {}),
      });
    case "prompts/get":
      return Option.match(decodeNamedParams(params), {
        onNone: () => ({}),
        onSome: ({ name }) => (name ? { "mcp.prompt.name": name } : {}),
      });
    default:
      return {};
  }
};

const replyAttrs = (envelope: JsonRpcEnvelope): Record<string, unknown> => {
  if (!envelope.result || envelope.method) return {};
  return Option.match(decodeElicitationReplyResult(envelope.result), {
    onNone: () => ({}),
    onSome: ({ action }) => (action ? { "mcp.elicitation.action": action } : {}),
  });
};

const rpcAttrs = (envelope: Option.Option<JsonRpcEnvelope>): Record<string, unknown> =>
  Option.match(envelope, {
    onNone: () => ({}),
    onSome: (e) => ({
      ...(e.method && { "mcp.rpc.method": e.method }),
      ...(e.id !== undefined && e.id !== null && { "mcp.rpc.id": String(e.id) }),
      ...methodAttrs(e),
      ...replyAttrs(e),
    }),
  });

const annotateMcpRequest = (
  request: Request,
  opts: { token: VerifiedToken | null; parseBody: boolean },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const cf = getCfMeta(request);
    const baseAttrs: Record<string, unknown> = {
      "mcp.request.method": request.method,
      "mcp.request.session_id_present": !!request.headers.get("mcp-session-id"),
      "mcp.request.session_id": request.headers.get("mcp-session-id") ?? "",
      "mcp.auth.has_bearer": (request.headers.get("authorization") ?? "").startsWith(BEARER_PREFIX),
      "mcp.auth.verified": !!opts.token,
      "mcp.auth.organization_id": opts.token?.organizationId ?? "",
      "mcp.auth.account_id": opts.token?.accountId ?? "",
      "cf.country": cf.country ?? "",
      "cf.city": cf.city ?? "",
      "cf.region": cf.region ?? "",
      "cf.timezone": cf.timezone ?? "",
      "cf.asn": cf.asn ?? 0,
      "cf.as_organization": cf.asOrganization ?? "",
      "cf.tls_version": cf.tlsVersion ?? "",
      "cf.tls_cipher": cf.tlsCipher ?? "",
      "cf.http_protocol": cf.httpProtocol ?? "",
      "cf.colo": cf.colo ?? "",
      ...dumpHeaders(request),
    };

    const envelope = opts.parseBody ? yield* readJsonRpcEnvelope(request) : Option.none();
    const attrs = {
      ...baseAttrs,
      ...rpcAttrs(envelope),
      "mcp.request.parse_body": opts.parseBody,
    };

    yield* Effect.annotateCurrentSpan(attrs);
    yield* Effect.annotateCurrentSpan(attrs).pipe(Effect.withSpan("mcp.request.annotate"));
  });

// ---------------------------------------------------------------------------
// OAuth metadata endpoints
// ---------------------------------------------------------------------------

const protectedResourceMetadata = Effect.sync(() =>
  jsonResponse({
    resource: RESOURCE_URL,
    authorization_servers: [AUTHKIT_DOMAIN],
    bearer_methods_supported: ["header"],
    scopes_supported: [],
  }),
);

const authorizationServerMetadata = Effect.tryPromise({
  try: async () => {
    const res = await fetch(`${AUTHKIT_DOMAIN}/.well-known/oauth-authorization-server`);
    if (!res.ok) return jsonResponse({ error: "upstream_error" }, 502);
    return jsonResponse(await res.json());
  },
  catch: () => undefined,
}).pipe(Effect.catchCause(() => Effect.succeed(jsonResponse({ error: "upstream_error" }, 502))));

// ---------------------------------------------------------------------------
// DO dispatch
// ---------------------------------------------------------------------------

// Worker and DO run in separate isolates with independent WebSdk tracer
// providers. Neither one can see the other's OTEL context, so the DO used
// to emit a brand-new root trace on every stub call. Ferry the worker span
// context across with W3C headers: `traceparent` generated from the active
// Effect span plus passthrough `tracestate` / `baggage` from the inbound
// request.
type IncomingPropagationHeaders = {
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly baggage?: string;
};

const currentTraceparent = Effect.map(Effect.currentSpan, (span) => {
  if (!span || !span.traceId || !span.spanId) return undefined;
  const flags = span.sampled ? "01" : "00";
  return `00-${span.traceId}-${span.spanId}-${flags}`;
}).pipe(Effect.orElseSucceed(() => undefined));

const currentPropagationHeaders = (request: Request): Effect.Effect<IncomingPropagationHeaders> =>
  Effect.map(currentTraceparent, (traceparent) => ({
    traceparent,
    tracestate: request.headers.get("tracestate") ?? undefined,
    baggage: request.headers.get("baggage") ?? undefined,
  }));

const withPropagationHeaders = (
  request: Request,
  propagation: IncomingPropagationHeaders,
): Request => {
  const headers = new Headers(request.headers);
  if (propagation.traceparent) {
    headers.set("traceparent", propagation.traceparent);
  }
  if (propagation.tracestate) {
    headers.set("tracestate", propagation.tracestate);
  }
  if (propagation.baggage) {
    headers.set("baggage", propagation.baggage);
  }
  return new Request(request, { headers });
};

const withVerifiedIdentityHeaders = (request: Request, token: VerifiedToken): Request => {
  const headers = new Headers(request.headers);
  headers.set(INTERNAL_ACCOUNT_ID_HEADER, token.accountId);
  headers.set(INTERNAL_ORGANIZATION_ID_HEADER, token.organizationId ?? "");
  return new Request(request, { headers });
};

const withMcpResponseHeaders = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", "mcp-session-id");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

/**
 * Forward a request to an existing session DO. Wrapping the DO's `Response`
 * with `HttpServerResponse.raw` lets streaming bodies (SSE) pass through
 * `HttpEffect.toWebHandler`'s conversion unchanged.
 */
const forwardToExistingSession = (
  request: Request,
  sessionId: string,
  peek: boolean,
  token: VerifiedToken,
) =>
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
    return HttpServerResponse.raw(withMcpResponseHeaders(annotated));
  });

const clearExistingSession = (request: Request, sessionId: string) =>
  Effect.gen(function* () {
    const ns = env.MCP_SESSION;
    const stub = ns.get(ns.idFromString(sessionId));
    const propagation = yield* currentPropagationHeaders(request);
    yield* Effect.promise(() => stub.clearSession(propagation) as Promise<void>).pipe(
      Effect.catchCause(() => Effect.void),
      Effect.withSpan("mcp.do.clear_session", {
        attributes: { "mcp.request.session_id_present": true },
      }),
    );
  });

const authorizeMcpOrganization = (
  request: Request,
  token: VerifiedToken,
  sessionId: string | null,
) =>
  Effect.gen(function* () {
    const organizationId = token.organizationId;
    if (!organizationId) {
      return jsonRpcError(403, -32001, "No organization in session — log in via the web app first");
    }

    const auth = yield* McpOrganizationAuth;
    const allowed = yield* auth.authorize(token.accountId, organizationId).pipe(
      Effect.catchCause((error) =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({
            "mcp.auth.organization_authorize_error": Cause.pretty(error),
          });
          return false;
        }),
      ),
      Effect.withSpan("mcp.auth.authorize_organization", {
        attributes: { "mcp.auth.organization_id": organizationId },
      }),
    );
    if (allowed) return null;

    if (sessionId) {
      yield* clearExistingSession(request, sessionId);
    }
    return jsonRpcError(403, -32001, "No organization in session — log in via the web app first");
  });

const dispatchPost = (request: Request, token: VerifiedToken) =>
  Effect.gen(function* () {
    const sessionId = request.headers.get("mcp-session-id");
    const authError = yield* authorizeMcpOrganization(request, token, sessionId);
    if (authError) return authError;
    const organizationId = token.organizationId!;

    if (sessionId) return yield* forwardToExistingSession(request, sessionId, true, token);

    const ns = env.MCP_SESSION;
    const stub = ns.get(ns.newUniqueId());
    const propagation = yield* currentPropagationHeaders(request);
    yield* Effect.promise(() =>
      stub.init({ organizationId, userId: token.accountId }, propagation),
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
    return HttpServerResponse.raw(withMcpResponseHeaders(annotated));
  });

const dispatchGet = (request: Request, token: VerifiedToken) => {
  const sessionId = request.headers.get("mcp-session-id");
  if (!sessionId)
    return Effect.succeed(jsonRpcError(400, -32000, "mcp-session-id header required for SSE"));
  return Effect.gen(function* () {
    const authError = yield* authorizeMcpOrganization(request, token, sessionId);
    if (authError) return authError;
    return yield* forwardToExistingSession(request, sessionId, false, token);
  });
};

const dispatchDelete = (request: Request, token: VerifiedToken) => {
  const sessionId = request.headers.get("mcp-session-id");
  if (!sessionId) return Effect.succeed(HttpServerResponse.empty({ status: 204 }));
  return Effect.gen(function* () {
    const authError = yield* authorizeMcpOrganization(request, token, sessionId);
    if (authError) return authError;
    return yield* forwardToExistingSession(request, sessionId, true, token);
  });
};

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

type McpRoute = "mcp" | "oauth-protected-resource" | "oauth-authorization-server" | null;

/**
 * Returns the MCP route type for a pathname, or `null` if the path isn't owned
 * by the MCP handler.
 *
 * Exported so the test worker can share the exact same predicate the middleware
 * uses — we avoid duplicating the "is this an MCP path?" logic across entry
 * points.
 */
export const classifyMcpPath = (pathname: string): McpRoute => {
  if (pathname === MCP_PATH) return "mcp";
  if (pathname === PROTECTED_RESOURCE_METADATA_PATH) return "oauth-protected-resource";
  if (pathname === "/.well-known/oauth-authorization-server") return "oauth-authorization-server";
  return null;
};

/**
 * Raw Effect-native MCP app. Exported so alternate entry points (e.g. the
 * vitest-pool-workers test worker) can provide their own auth layers because
 * hitting WorkOS JWKS / membership APIs is not practical in the isolate.
 */
export const mcpApp: Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest | McpAuth | McpOrganizationAuth
> = Effect.gen(function* () {
  const httpRequest = yield* HttpServerRequest.HttpServerRequest;
  const request = httpRequest.source as Request;
  const route = classifyMcpPath(new URL(request.url).pathname);

  if (request.method === "OPTIONS") return corsPreflight;
  if (route === "oauth-protected-resource") return yield* protectedResourceMetadata;
  if (route === "oauth-authorization-server") return yield* authorizationServerMetadata;

  const auth = yield* McpAuth;
  const authResult = yield* auth.verifyBearer(request).pipe(Effect.result);

  if (Result.isFailure(authResult)) {
    yield* annotateMcpRequest(request, {
      token: null,
      parseBody: false,
    });
    return yield* authTemporarilyUnavailable(authResult.failure);
  }
  const authValue = authResult.success;

  // Annotate before dispatch so even 401s show up with what we know. Only
  // POST bodies are JSON-RPC payloads worth parsing; GET (SSE) and DELETE
  // don't carry one.
  yield* annotateMcpRequest(request, {
    token: isMcpAuthorized(authValue) ? authValue.token : null,
    parseBody: request.method === "POST" && isMcpAuthorized(authValue),
  });

  if (isMcpUnauthorized(authValue)) {
    return unauthorized(authValue, PROTECTED_RESOURCE_METADATA_URL);
  }
  const token = authValue.token;
  switch (request.method) {
    case "POST":
      return yield* dispatchPost(request, token);
    case "GET":
      return yield* dispatchGet(request, token);
    case "DELETE":
      return yield* dispatchDelete(request, token);
    default:
      return jsonRpcError(405, -32001, "Method not allowed");
  }
}).pipe(
  Effect.withSpan("mcp.request"),
  Effect.catchCause((cause) =>
    Effect.sync(() => {
      console.error("[mcp] request failed:", Cause.pretty(cause));
      captureCause(cause);
      return jsonRpcError(500, -32603, "Internal server error");
    }),
  ),
);

const rawMcpFetch = HttpEffect.toWebHandler(
  mcpApp.pipe(
    Effect.provide(
      Layer.mergeAll(
        McpAuthLive.pipe(
          Layer.provide(ApiKeyService.WorkOS.pipe(Layer.provide(CoreSharedServices))),
        ),
        McpOrganizationAuthLive,
        TelemetryLive,
      ),
    ),
  ),
);

/**
 * Fetch handler for /mcp + /.well-known/* paths.
 *
 * Returns `null` when the path doesn't match a known MCP route so the caller
 * (`start.ts`'s mcpRequestMiddleware) can fall through to `next()` and let
 * TanStack Start handle normal routing — e.g. an unknown `/.well-known/*`
 * path that should 404 through the regular route tree.
 */
export const mcpFetch = async (request: Request): Promise<Response | null> => {
  if (classifyMcpPath(new URL(request.url).pathname) === null) return null;
  return rawMcpFetch(request);
};
