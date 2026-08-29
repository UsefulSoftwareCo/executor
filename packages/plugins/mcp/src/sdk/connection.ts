import type { Client, FetchLike, OAuthClientProvider } from "@modelcontextprotocol/client";
import { Effect, Layer, Option, Predicate, Schema, Stream } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";

// NOTE: nothing from `@modelcontextprotocol/client` is imported eagerly —
// value access goes through `loadMcpClientSdk` (see client-module.ts for the
// isolate-startup cost rationale). `StdioClientTransport` additionally stays
// out of even the lazy barrel: the upstream `@modelcontextprotocol/client/stdio`
// entry imports Node process/stream and `cross-spawn` at evaluation time,
// which crashes workerd (including vitest-pool-workers) with SIGSEGV on
// module instantiation. Cloud callers set `dangerouslyAllowStdioMCP: false`
// and never reach the stdio branch below; prod bundles that DO use stdio load
// it via the dynamic import inside the stdio branch of `createMcpConnector`.
import { loadMcpClientSdk, type McpClientSdk } from "./client-module";

import type { McpRemoteIntegrationConfig, McpStdioIntegrationConfig } from "./types";
import {
  McpConnectionError,
  McpConnectionFailureKind,
  McpInsufficientScopeError,
  McpOAuthReauthorizationRequired,
} from "./errors";
import { connectionHttpStatusFromCause, isStreamableHttpProtocolError } from "./http-status";
import { detectInsufficientScope } from "@executor-js/sdk/core";

// ---------------------------------------------------------------------------
// Connection type
// ---------------------------------------------------------------------------

export type McpConnection = {
  readonly client: Client;
  readonly close: () => Promise<void>;
};

export type McpConnector = Effect.Effect<
  McpConnection,
  McpConnectionError | McpOAuthReauthorizationRequired
>;

// ---------------------------------------------------------------------------
// Connector input — extends stored source data with resolved auth
// ---------------------------------------------------------------------------

export type RemoteConnectorInput = Omit<
  McpRemoteIntegrationConfig,
  "authenticationTemplate" | "remoteTransport" | "headers" | "queryParams"
> & {
  readonly remoteTransport?: McpRemoteIntegrationConfig["remoteTransport"];
  readonly headers?: Record<string, string>;
  readonly queryParams?: Record<string, string>;
  readonly authProvider?: OAuthClientProvider;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
};

export type StdioConnectorInput = McpStdioIntegrationConfig;

export type ConnectorInput = RemoteConnectorInput | StdioConnectorInput;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const buildEndpointUrl = (endpoint: string, queryParams: Record<string, string>): URL => {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(queryParams)) {
    url.searchParams.set(key, value);
  }
  return url;
};

type HttpMethod = Parameters<typeof HttpClientRequest.make>[0];
const HTTP_METHODS = new Set<HttpMethod>([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
]);

const httpMethodFrom = (method: string | undefined): HttpMethod => {
  const normalized = (method ?? "GET").toUpperCase() as HttpMethod;
  return HTTP_METHODS.has(normalized) ? normalized : "POST";
};

const headersFrom = (headers: HeadersInit | undefined): Headers =>
  headers ? new Headers(headers) : new Headers();

const recordFromHeaders = (headers: Headers): Record<string, string> =>
  Object.fromEntries(headers.entries());

const ExternalTransportCause = Schema.Struct({
  code: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
  data: Schema.optional(
    Schema.Struct({
      cause: Schema.optional(Schema.Unknown),
    }),
  ),
});
const decodeExternalTransportCause = Schema.decodeUnknownOption(ExternalTransportCause);

const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const DNS_ERROR_CODES = new Set(["EAI_AGAIN", "ENOTFOUND"]);
const TIMEOUT_ERROR_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);
const PROTOCOL_HTTP_STATUSES = new Set([400, 404, 405, 406, 415, 422, 501]);

const CONNECTION_FAILURE_MESSAGES: Record<McpConnectionFailureKind, string> = {
  tls: "MCP HTTPS connection failed: TLS certificate verification failed. Check the server certificate and Executor's CA trust configuration.",
  dns: "MCP connection failed: the server hostname could not be resolved.",
  timeout: "MCP connection failed: the server did not respond before the connection timed out.",
  connection_refused: "MCP connection failed: the server refused the connection.",
  network: "MCP connection failed before transport negotiation completed.",
  http: "MCP server rejected the HTTP connection.",
  protocol: "MCP server does not support the requested transport.",
};

const CONNECTION_ATTEMPT_SUMMARIES: Partial<Record<McpConnectionFailureKind, string>> = {
  tls: "TLS certificate verification failed",
  dns: "hostname resolution failed",
  timeout: "connection timed out",
  connection_refused: "connection refused",
  protocol: "unsupported protocol response",
};

class McpHttpTransportError extends Schema.TaggedErrorClass<McpHttpTransportError>()(
  "McpHttpTransportError",
  {
    failureKind: McpConnectionFailureKind,
    cause: Schema.Defect,
  },
) {}
const decodeMcpHttpTransportError = Schema.decodeUnknownOption(McpHttpTransportError);

const nestedMcpHttpTransportError = (cause: unknown): Option.Option<McpHttpTransportError> => {
  let current: unknown = cause;
  for (let depth = 0; depth < 8; depth += 1) {
    const decodedError = decodeMcpHttpTransportError(current);
    if (Option.isSome(decodedError)) return decodedError;
    const decodedCause = decodeExternalTransportCause(current);
    if (Option.isNone(decodedCause)) return Option.none();
    current = decodedCause.value.cause ?? decodedCause.value.data?.cause;
    if (current === undefined) return Option.none();
  }
  return Option.none();
};

const externalTransportCodes = (cause: unknown): ReadonlySet<string> => {
  const codes = new Set<string>();
  let current: unknown = cause;
  for (let depth = 0; depth < 8; depth += 1) {
    const decoded = decodeExternalTransportCause(current);
    if (Option.isNone(decoded)) break;
    if (decoded.value.code !== undefined) codes.add(decoded.value.code);
    current = decoded.value.cause ?? decoded.value.data?.cause;
    if (current === undefined) break;
  }
  return codes;
};

const classifyHttpClientFailure = (
  failure: HttpClientError.HttpClientError,
): McpConnectionFailureKind => {
  if (!Predicate.isTagged(failure.reason, "TransportError")) return "network";
  const codes = externalTransportCodes(failure.reason.cause);
  if ([...codes].some((code) => TLS_ERROR_CODES.has(code))) return "tls";
  if ([...codes].some((code) => DNS_ERROR_CODES.has(code))) return "dns";
  if ([...codes].some((code) => TIMEOUT_ERROR_CODES.has(code))) return "timeout";
  if (codes.has("ECONNREFUSED")) return "connection_refused";
  return "network";
};

const normalizeHttpClientFailure = (
  failure: HttpClientError.HttpClientError,
): McpHttpTransportError =>
  new McpHttpTransportError({
    failureKind: classifyHttpClientFailure(failure),
    cause: failure,
  });

const applyBody = async (
  request: HttpClientRequest.HttpClientRequest,
  headers: Headers,
  body: BodyInit | null | undefined,
): Promise<HttpClientRequest.HttpClientRequest> => {
  if (body == null) return request;
  const contentType = headers.get("content-type") ?? undefined;
  if (typeof body === "string") return HttpClientRequest.bodyText(request, body, contentType);
  if (body instanceof URLSearchParams) {
    return HttpClientRequest.bodyText(
      request,
      body.toString(),
      contentType ?? "application/x-www-form-urlencoded;charset=UTF-8",
    );
  }
  if (body instanceof Uint8Array)
    return HttpClientRequest.bodyUint8Array(request, body, contentType);
  if (body instanceof ArrayBuffer) {
    return HttpClientRequest.bodyUint8Array(request, new Uint8Array(body), contentType);
  }
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  return HttpClientRequest.bodyUint8Array(request, bytes, contentType);
};

const abortError = (signal: AbortSignal): unknown => {
  if (signal.reason !== undefined) return signal.reason;
  // oxlint-disable-next-line executor/no-error-constructor -- boundary: Fetch-compatible adapter must reject with an AbortError-shaped value
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
};

/** An effect that completes when `signal` aborts (already-aborted = now). */
const awaitAbort = (signal: AbortSignal): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    signal.addEventListener("abort", () => resume(Effect.void), { once: true });
  });

const fetchFromHttpClientLayer = (
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
): FetchLike => {
  const execute: FetchLike = async (url, init) => {
    const headers = headersFrom(init?.headers);
    const requestWithoutBody = HttpClientRequest.make(httpMethodFrom(init?.method))(url, {
      headers: recordFromHeaders(headers),
    });
    const request = await applyBody(requestWithoutBody, headers, init?.body);
    const effect = Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(request);
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (value !== undefined) responseHeaders.set(key, value);
      }
      // Abort must reach the body, not just the pending request: this stream
      // fiber outlives the `runPromise` below, so without this streamable
      // http's SSE `GET` stays in flight after `close()`. Interrupted at the
      // source because the SDK holds a locked reader on that same stream,
      // which rules out cancelling the ReadableStream.
      const stream =
        init?.signal == null
          ? response.stream
          : Stream.interruptWhen(response.stream, awaitAbort(init.signal));
      const body =
        response.status === 204 || response.status === 205 || response.status === 304
          ? null
          : Stream.toReadableStream(stream);
      return new Response(body, {
        status: response.status,
        headers: responseHeaders,
      });
    }).pipe(Effect.mapError(normalizeHttpClientFailure), Effect.provide(httpClientLayer));
    // A 403 carrying an RFC 6750 insufficient_scope challenge is intercepted
    // HERE, below the SDK: with an authProvider the SDK would consume the
    // challenge and re-run auth ("upscoping"), which our static-token
    // provider can only answer by demanding reauthorization — misclassifying
    // an unfixable scope shortfall as oauth_reauth_required. Thrown as the
    // tagged error from the fetch adapter (a true runtime edge: the SDK
    // consumes promise rejections) so it reaches the invoke/connect catch
    // sites verbatim.
    const promise = Effect.runPromise(effect).then((response) => {
      if (response.status === 403) {
        const challenge = response.headers.get("www-authenticate");
        if (
          challenge !== null &&
          detectInsufficientScope({ headers: { "www-authenticate": challenge } }) !== null
        ) {
          // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: Fetch-compatible adapter can only signal through a rejected promise
          throw new McpInsufficientScopeError({
            message:
              "MCP server rejected the call: the OAuth grant does not cover the required scope",
          });
        }
      }
      return response;
    });
    // Mark the request promise observed (a no-op handler on the ORIGINAL
    // promise; callers still see the rejection). The MCP SDK fires some
    // requests without a rejection handler — a cancellation notification
    // after a request timeout, an SSE dial raced against an abort — and when
    // the upstream is already gone that rejection is unhandled, which kills
    // the whole Bun server process, not just this call. Browsers never crash
    // on an unobserved fetch rejection; this adapter must match.
    // oxlint-disable-next-line executor/no-promise-catch -- boundary: Fetch-compatible adapter must observe rejections the SDK abandons
    promise.catch(() => undefined);
    if (!init?.signal) return promise;
    // oxlint-disable-next-line executor/no-promise-reject -- boundary: Fetch-compatible adapter mirrors abort rejection semantics
    if (init.signal.aborted) return Promise.reject(abortError(init.signal));
    const aborted = new Promise<never>((_, reject) => {
      // oxlint-disable-next-line executor/no-promise-reject -- boundary: Fetch-compatible adapter races the Effect request against AbortSignal
      init.signal?.addEventListener("abort", () => reject(abortError(init.signal!)), {
        once: true,
      });
    });
    return Promise.race([promise, aborted]);
  };
  return execute;
};

// Use the cfworker JSON Schema validator instead of the SDK's default
// (Ajv). Ajv compiles schemas via `new Function(...)`, which throws
// `Code generation from strings disallowed for this context` when the
// MCP plugin runs inside a Cloudflare Worker (executor.sh). The
// cfworker validator does not use code generation and works in every
// runtime we ship to.
const createClient = (sdk: McpClientSdk, versionNegotiation?: { readonly mode: "auto" }): Client =>
  new sdk.client.Client(
    { name: "executor-mcp", version: "0.1.0" },
    {
      capabilities: { elicitation: { form: {}, url: {} } },
      jsonSchemaValidator: new sdk.validators.CfWorkerJsonSchemaValidator(),
      ...(versionNegotiation === undefined ? {} : { versionNegotiation }),
    },
  );

const connectionFromClient = (client: Client): McpConnection => ({
  client,
  close: () => client.close(),
});

const connectionFailure = (
  transport: string,
  message: string,
  cause: unknown,
): McpConnectionError | McpOAuthReauthorizationRequired => {
  if (Predicate.isTagged(cause, "McpOAuthReauthorizationRequired")) {
    return new McpOAuthReauthorizationRequired({ message: "MCP OAuth re-authorization required" });
  }
  if (Predicate.isTagged(cause, "McpInsufficientScopeError")) {
    // Surfaced as a connection error with the 403 status; the invoke/connect
    // catch sites detect the tag and classify as oauth_scope_insufficient.
    return new McpConnectionError({
      transport,
      message: `${message} (HTTP 403: insufficient scope)`,
      httpStatus: 403,
      insufficientScope: true,
    });
  }
  const httpTransportError = nestedMcpHttpTransportError(cause);
  if (Option.isSome(httpTransportError)) {
    return new McpConnectionError({
      transport,
      message: CONNECTION_FAILURE_MESSAGES[httpTransportError.value.failureKind],
      failureKind: httpTransportError.value.failureKind,
    });
  }
  // Carry the handshake HTTP status structurally (and in the message for
  // humans) so the liveness health check can classify a rejected credential
  // as expired rather than a generic connection failure.
  const status = connectionHttpStatusFromCause(cause);
  const failureKind: McpConnectionFailureKind =
    isStreamableHttpProtocolError(cause) ||
    (status !== undefined && PROTOCOL_HTTP_STATUSES.has(status))
      ? "protocol"
      : status === undefined
        ? "network"
        : "http";
  return new McpConnectionError({
    transport,
    message: status === undefined ? message : `${message} (HTTP ${status})`,
    failureKind,
    ...(status === undefined ? {} : { httpStatus: status }),
  });
};

const connectionAttemptSummary = (failure: McpConnectionError): string => {
  if (failure.httpStatus !== undefined) return `HTTP ${failure.httpStatus}`;
  return failure.failureKind === undefined
    ? "connection failed"
    : (CONNECTION_ATTEMPT_SUMMARIES[failure.failureKind] ?? "connection failed");
};

const autoTransportFailure = (
  streamableHttp: McpConnectionError,
  sse: McpConnectionError,
): McpConnectionError =>
  new McpConnectionError({
    transport: "auto",
    // The SSE fallback is the TERMINAL attempt, so its structural
    // classification is this failure's: a timed-out fallback is a timeout
    // and a fallback that hit an HTTP wall carries that status — collapsing
    // everything to "protocol" made the health check read a slow-but-alive
    // server as a generic probe failure. "protocol" remains only the default
    // for an unclassified fallback error.
    failureKind: sse.failureKind ?? "protocol",
    ...(sse.httpStatus !== undefined ? { httpStatus: sse.httpStatus } : {}),
    message: `MCP auto transport failed. Streamable HTTP: ${connectionAttemptSummary(streamableHttp)}. SSE fallback: ${connectionAttemptSummary(sse)}.`,
  });

const connectClient = (input: {
  transport: string;
  createTransport: (sdk: McpClientSdk) => Parameters<Client["connect"]>[0];
  versionNegotiation?: { readonly mode: "auto" };
}): Effect.Effect<McpConnection, McpConnectionError | McpOAuthReauthorizationRequired> =>
  Effect.gen(function* () {
    const sdk = yield* Effect.tryPromise({
      try: () => loadMcpClientSdk(),
      catch: () =>
        new McpConnectionError({
          transport: input.transport,
          message: "Failed to load MCP client module",
        }),
    });
    const client = createClient(sdk, input.versionNegotiation);
    const transportInstance = input.createTransport(sdk);

    yield* Effect.tryPromise({
      // Interruption (an HTTP 499 cancelling a health check, the discovery
      // timeout) aborts this signal; the SDK then fails the in-flight
      // handshake and closes the transport. Without it the abandoned connect
      // kept the spawned stdio child alive forever; `docker run -i --rm`
      // integrations stranded a container per interrupted dial (#1631).
      try: (signal) => client.connect(transportInstance, { signal }),
      catch: (cause) =>
        connectionFailure(input.transport, `Failed connecting via ${input.transport}`, cause),
    }).pipe(
      // The negotiated era ("modern" = 2026-07-28 server/discover, "legacy" =
      // 2025 initialize) is otherwise invisible: both eras list and call tools
      // identically, so traces are the one place an integration author can
      // verify which handshake a connection actually used.
      Effect.tap(() =>
        Effect.annotateCurrentSpan({
          "plugin.mcp.protocol_era": client.getProtocolEra() ?? "unknown",
        }),
      ),
      Effect.withSpan("plugin.mcp.connection.handshake", {
        attributes: { "plugin.mcp.transport": input.transport },
      }),
    );

    return connectionFromClient(client);
  });

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export const createMcpConnector = (input: ConnectorInput): McpConnector => {
  if (input.transport === "stdio") {
    const command = input.command.trim();
    if (!command) {
      return Effect.fail(
        new McpConnectionError({
          transport: "stdio",
          message: "MCP stdio transport requires a command",
        }),
      );
    }

    return Effect.gen(function* () {
      // Dynamic import so the underlying module (which evaluates
      // `node:child_process`) is only loaded when stdio is actually used.
      const { createStdioTransport } = yield* Effect.tryPromise({
        try: () => import("./stdio-connector"),
        catch: () =>
          new McpConnectionError({
            transport: "stdio",
            message: "Failed to load stdio transport module",
          }),
      });

      return yield* connectClient({
        transport: "stdio",
        // Opt-in per integration (default legacy) — see
        // `McpStdioVersionNegotiation` for why stdio does not follow the
        // remote transport's unconditional auto.
        ...(input.versionNegotiation === "auto"
          ? { versionNegotiation: { mode: "auto" as const } }
          : {}),
        createTransport: () =>
          createStdioTransport({
            command,
            args: input.args,
            env: input.env,
            cwd: input.cwd?.trim().length ? input.cwd.trim() : undefined,
          }),
      });
    });
  }

  // Remote transport
  const headers = input.headers ?? {};
  const remoteTransport = input.remoteTransport ?? "auto";
  const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;
  const fetch = input.httpClientLayer ? fetchFromHttpClientLayer(input.httpClientLayer) : undefined;

  const endpoint = buildEndpointUrl(input.endpoint, input.queryParams ?? {});

  // Auto-negotiate the 2026-07-28 era unconditionally only on Streamable
  // HTTP. SSE is a legacy-only transport; stdio negotiates per the
  // integration's `versionNegotiation` (default legacy — see the stdio
  // branch above).
  const connectStreamableHttp = connectClient({
    transport: "streamable-http",
    versionNegotiation: { mode: "auto" },
    createTransport: (sdk) =>
      new sdk.client.StreamableHTTPClientTransport(endpoint, {
        requestInit,
        authProvider: input.authProvider,
        fetch,
      }),
  });

  const connectSse = connectClient({
    transport: "sse",
    createTransport: (sdk) =>
      new sdk.client.SSEClientTransport(endpoint, {
        requestInit,
        authProvider: input.authProvider,
        fetch,
      }),
  });

  if (remoteTransport === "streamable-http") return connectStreamableHttp;
  if (remoteTransport === "sse") return connectSse;

  // auto: try streamable-http first, fall back to SSE for TRANSPORT failures
  // only. A definitive auth wall (401/403) is about the credential, not the
  // transport: the same endpoint would reject SSE too, and retrying it via
  // SSE loses the HTTP status (the SSE POST failure is a different, opaque
  // error), which used to misclassify an expired token as a generic
  // connection failure. Propagate it as-is instead.
  return connectStreamableHttp.pipe(
    Effect.catchTags({
      McpOAuthReauthorizationRequired: Effect.fail,
      McpConnectionError: (error) => {
        if (error.httpStatus === 401 || error.httpStatus === 403) return Effect.fail(error);
        if (error.failureKind !== "protocol") return Effect.fail(error);
        return connectSse.pipe(
          Effect.catchTags({
            McpOAuthReauthorizationRequired: Effect.fail,
            McpConnectionError: (sseError) => Effect.fail(autoTransportFailure(error, sseError)),
          }),
        );
      },
    }),
  );
};
