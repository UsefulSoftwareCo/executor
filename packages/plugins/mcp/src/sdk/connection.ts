import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { Effect, Layer, Predicate, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

// NOTE: `StdioClientTransport` is NOT imported eagerly. The upstream module
// (`@modelcontextprotocol/sdk/client/stdio.js`) touches `node:child_process`
// at evaluation time, which crashes workerd (incl. vitest-pool-workers) at
// SIGSEGV on module instantiation. Cloud callers set
// `dangerouslyAllowStdioMCP: false` and never reach the stdio branch below;
// prod bundles that DO use stdio load it via a dynamic import inside the
// stdio branch of `createMcpConnector`.

import type { McpRemoteIntegrationConfig, McpStdioIntegrationConfig } from "./types";
import { McpConnectionError, McpOAuthReauthorizationRequired } from "./errors";

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
      const body =
        response.status === 204 || response.status === 205 || response.status === 304
          ? null
          : Stream.toReadableStream(response.stream);
      return new Response(body, {
        status: response.status,
        headers: responseHeaders,
      });
    }).pipe(Effect.provide(httpClientLayer));
    const promise = Effect.runPromise(effect);
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
const createClient = (): Client =>
  new Client(
    { name: "executor-mcp", version: "0.1.0" },
    {
      capabilities: { elicitation: { form: {}, url: {} } },
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
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
  return new McpConnectionError({ transport, message });
};

const connectClient = (input: {
  transport: string;
  createTransport: () => Parameters<Client["connect"]>[0];
}): Effect.Effect<McpConnection, McpConnectionError | McpOAuthReauthorizationRequired> =>
  Effect.gen(function* () {
    const client = createClient();
    const transportInstance = input.createTransport();

    yield* Effect.tryPromise({
      try: () => client.connect(transportInstance),
      catch: (cause) =>
        connectionFailure(input.transport, `Failed connecting via ${input.transport}`, cause),
    }).pipe(
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

  const connectStreamableHttp = connectClient({
    transport: "streamable-http",
    createTransport: () =>
      new StreamableHTTPClientTransport(endpoint, {
        requestInit,
        authProvider: input.authProvider,
        fetch,
      }),
  });

  const connectSse = connectClient({
    transport: "sse",
    createTransport: () =>
      new SSEClientTransport(endpoint, {
        requestInit,
        authProvider: input.authProvider,
        fetch,
      }),
  });

  if (remoteTransport === "streamable-http") return connectStreamableHttp;
  if (remoteTransport === "sse") return connectSse;

  // auto: try streamable-http first, fall back to SSE for transport failures.
  return connectStreamableHttp.pipe(
    Effect.catch((error) =>
      Predicate.isTagged(error, "McpOAuthReauthorizationRequired")
        ? Effect.fail(error)
        : connectSse,
    ),
  );
};
