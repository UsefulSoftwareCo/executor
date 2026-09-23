/** Official MCP transports at an Effect boundary. Connections belong to one operation. */
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError as ProtocolError } from "@modelcontextprotocol/sdk/types.js";
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { captureTelemetry } from "@executor-js/telemetry";
import { Effect, Redacted, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  defaultMcpClientLimits,
  McpError,
  McpToolsOptions,
  type McpConnection,
} from "../contracts/mcp.ts";
import { adaptMcpTools } from "./mcp-tools.ts";
import { mcpClient, mcpJsonSchemaValidator } from "./mcp-client.ts";

/** Safe projection of transport errors. Raw messages can contain credential-bearing URLs. */
const failure = (phase: McpError["phase"], error: unknown): McpError => {
  const status =
    error instanceof UnauthorizedError
      ? 401
      : error instanceof StreamableHTTPError || error instanceof SseError
        ? error.code
        : undefined;
  return new McpError({
    phase,
    reason:
      error instanceof ProtocolError && error.code === ErrorCode.RequestTimeout
        ? "timeout"
        : status === 401 || status === 403
          ? "unauthorized"
          : "request",
    ...(status === undefined ? {} : { status }),
  });
};

// The library consumes Web Responses; Effect owns requests and streaming bodies.
// Retain the transport abort signal after response headers arrive.
const transportFetch =
  (connection: McpConnection, telemetry: Effect.Success<typeof captureTelemetry>): FetchLike =>
  (url, init) =>
    Effect.runPromiseWith(telemetry.context)(
      Effect.gen(function* () {
        const target = yield* Effect.try({
          try: () => new URL(url),
          catch: () => failure("transport", undefined),
        });
        if (target.origin !== connection.url.origin || target.username || target.password)
          return yield* failure("transport", undefined);
        const headers = new Headers(Redacted.value(connection.headers));
        new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
        const request = yield* Effect.try({
          try: () => HttpClientRequest.fromWeb(new Request(target, { ...init, headers })),
          catch: () => failure("transport", undefined),
        });
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.execute(request);
        return new Response(
          [204, 205, 304].includes(response.status)
            ? null
            : Stream.toReadableStream(response.stream),
          {
            status: response.status,
            headers: response.headers,
          },
        );
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.provideService(FetchHttpClient.Fetch, (url, options) =>
          globalThis.fetch(url, {
            ...options,
            signal: AbortSignal.any([
              ...(options?.signal ? [options.signal] : []),
              ...(init?.signal ? [init.signal] : []),
            ]),
          }),
        ),
        Effect.mapError(() => failure("transport", undefined)),
      ),
      init?.signal ? { signal: init.signal } : {},
    );

function withClient<A, E>(
  connection: McpConnection,
  mode: "discover" | "call",
  use: (client: Client) => Effect.Effect<A, E>,
) {
  const attempt = (kind: "http" | "sse") =>
    Effect.scoped(
      Effect.gen(function* () {
        const telemetry = yield* captureTelemetry;
        const { client, transport } = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const fetch = transportFetch(connection, telemetry);
            return {
              client: new Client(
                { name: "executor-apps", version: "0.1.0" },
                {
                  jsonSchemaValidator: mcpJsonSchemaValidator,
                  capabilities: mode === "call" ? { elicitation: { form: {} } } : {},
                },
              ),
              transport:
                kind === "http"
                  ? new StreamableHTTPClientTransport(connection.url, {
                      fetch,
                      reconnectionOptions: {
                        maxRetries: 0,
                        initialReconnectionDelay: 1_000,
                        maxReconnectionDelay: 1_000,
                        reconnectionDelayGrowFactor: 1,
                      },
                    })
                  : new SSEClientTransport(connection.url, { fetch }),
            };
          }),
          ({ client, transport }) =>
            Effect.gen(function* () {
              if (
                transport instanceof StreamableHTTPClientTransport &&
                transport.sessionId !== undefined
              ) {
                yield* Effect.tryPromise(() => transport.terminateSession()).pipe(
                  Effect.timeout(defaultMcpClientLimits.cleanupTimeoutMs),
                  Effect.ignore,
                );
              }
              yield* Effect.tryPromise(() => client.close()).pipe(
                Effect.timeout(defaultMcpClientLimits.cleanupTimeoutMs),
                Effect.ignore,
              );
            }).pipe(Effect.withSpan("provider.mcp.close")),
        );
        // Hide the SDK getter that conflicts with its own exact-optional Transport type.
        const wire: Omit<StreamableHTTPClientTransport, "sessionId"> | SSEClientTransport =
          transport;
        yield* Effect.tryPromise({
          try: (signal) => client.connect(wire, { signal, timeout: connection.timeoutMs }),
          catch: (error) => failure("connect", error),
        }).pipe(Effect.timeout(connection.timeoutMs), Effect.withSpan("provider.mcp.connect"));
        return yield* use(client);
      }),
    ).pipe(
      Effect.withSpan("provider.mcp.session", {
        attributes: {
          "mcp.transport": kind,
          "mcp.operation": mode,
          "server.address": connection.url.hostname,
        },
      }),
    );
  return attempt("http").pipe(
    // Fallback is only for negotiation. Tool calls are never automatically replayed.
    Effect.catch((error) =>
      Schema.is(McpError)(error) &&
      error.phase === "connect" &&
      (error.status === 404 || error.status === 405)
        ? attempt("sse")
        : Effect.fail(error),
    ),
    (operation) =>
      mode === "discover" ? operation.pipe(Effect.timeout(connection.timeoutMs)) : operation,
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new McpError({ phase: "transport", reason: "timeout" })),
    ),
  );
}

/** Discover and call with a fresh selected-account transport for each operation. */
export const mcpToolsEffect = (input: McpToolsOptions) =>
  Effect.gen(function* () {
    const options = yield* Schema.decodeUnknownEffect(McpToolsOptions)(input).pipe(
      Effect.mapError(() => new McpError({ phase: "connect", reason: "invalid_input" })),
    );
    const url = new URL(options.url);
    if (url.username || url.password || url.hash)
      return yield* new McpError({ phase: "connect", reason: "invalid_input" });
    const connection: McpConnection = {
      url,
      headers: Redacted.make({ ...options.headers }),
      timeoutMs: options.timeoutMs ?? defaultMcpClientLimits.timeoutMs,
    };
    return yield* adaptMcpTools(
      mcpClient((mode, use) => withClient(connection, mode, use), connection.timeoutMs, failure),
    );
  });
