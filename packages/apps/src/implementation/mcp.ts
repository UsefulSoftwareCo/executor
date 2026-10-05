import { httpProviderError, accountProviderError } from "./provider-error.ts";
import { ProviderError } from "../contracts/provider-error.ts";
/** Official MCP transports at an Effect boundary. Connections belong to one operation. */
import {
  UnauthorizedError,
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  SseError,
  StreamableHTTPClientTransport,
  type FetchLike,
} from "@modelcontextprotocol/client";
import { captureTelemetry } from "@executor-js/telemetry";
import { Deferred, Effect, Match, Option, Redacted, Schema, Stream } from "effect";
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
const failure = (phase: McpError["phase"], error: unknown): McpError | ProviderError => {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  let timedOut = false;
  for (let depth = 0; pending.length > 0 && depth < 16; depth++) {
    const cause = pending.shift();
    if (seen.has(cause)) continue;
    seen.add(cause);
    if (Schema.is(ProviderError)(cause) || Schema.is(McpError)(cause)) return cause;
    const status = Match.value(cause).pipe(
      Match.when(
        (value: unknown) => value instanceof UnauthorizedError,
        () => 401,
      ),
      Match.when(
        (value: unknown) => value instanceof SdkHttpError,
        (value) => value.status,
      ),
      Match.when(
        (value: unknown) => value instanceof SseError,
        (value) => value.code,
      ),
      Match.orElse(() => undefined),
    );
    if (status !== undefined)
      return httpProviderError(status) ?? new McpError({ phase, reason: "request", status });
    if (cause instanceof SdkError && cause.code === SdkErrorCode.RequestTimeout) timedOut = true;
    if (typeof cause === "object" && cause !== null) {
      if ("cause" in cause) pending.push(cause.cause);
      if (
        "data" in cause &&
        typeof cause.data === "object" &&
        cause.data !== null &&
        "cause" in cause.data
      )
        pending.push(cause.data.cause);
    }
  }
  return new McpError({ phase, reason: timedOut ? "timeout" : "request" });
};

const sentMethod = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ method: Schema.String })),
);

// The library consumes Web Responses; Effect owns requests and streaming bodies.
// Retain the transport abort signal after response headers arrive.
const transportFetch =
  (
    connection: McpConnection,
    telemetry: Effect.Success<typeof captureTelemetry>,
    rejected: Deferred.Deferred<never, ProviderError>,
    initialized: () => void,
  ): FetchLike =>
  (url, init) =>
    Effect.runPromiseWith(telemetry.context)(
      Effect.gen(function* () {
        // Executor's own refusals name the setting or server response at fault, never a network failure.
        if (
          Option.exists(
            sentMethod(init?.body),
            (message) => message.method === "notifications/initialized",
          )
        )
          initialized();
        const target = yield* Effect.try({
          try: () => new URL(url),
          catch: () => new McpError({ phase: "transport", reason: "invalid_response" }),
        });
        if (connection.url.username || connection.url.password)
          return yield* new McpError({ phase: "transport", reason: "invalid_input" });
        // The server directed the client to another origin or embedded credentials in a URL.
        if (target.origin !== connection.url.origin || target.username || target.password)
          return yield* new McpError({ phase: "transport", reason: "invalid_response" });
        const headers = new Headers(Redacted.value(connection.headers));
        new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
        const request = yield* Effect.try({
          try: () => HttpClientRequest.fromWeb(new Request(target, { ...init, headers })),
          catch: () => failure("transport", undefined),
        });
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.execute(request);
        const provider = httpProviderError(response.status, response.headers);
        if (provider !== undefined) {
          // EventSource replaces rejected fetch errors. Retain our safe failure
          // within this session so SSE cannot erase its status or reason.
          yield* Deferred.fail(rejected, provider);
          return yield* provider;
        }
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
        Effect.mapError((error) => failure("transport", error)),
      ),
      init?.signal ? { signal: init.signal } : {},
    );

function withClient<A, E>(
  connection: McpConnection,
  mode: "discover" | "call",
  use: (client: Client) => Effect.Effect<A, E>,
  changed?: Effect.Effect<void, unknown>,
) {
  return Effect.suspend(() => {
    let pendingFallback: McpError | undefined;
    const attempt = (kind: "http" | "sse", original?: McpError) =>
      Effect.scoped(
        Effect.gen(function* () {
          const telemetry = yield* captureTelemetry;
          const rejected = yield* Deferred.make<never, ProviderError>();
          const pending = new Set<Promise<void>>();
          let initialized = false;
          const { client, transport } = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const fetch = transportFetch(connection, telemetry, rejected, () => {
                initialized = true;
              });
              const client = new Client(
                { name: "executor-apps", version: "0.1.0" },
                {
                  jsonSchemaValidator: mcpJsonSchemaValidator,
                  versionNegotiation: { mode: kind === "http" ? "auto" : "legacy" },
                  capabilities: mode === "call" ? { elicitation: { form: {} } } : {},
                },
              );
              if (changed !== undefined) {
                client.setNotificationHandler("notifications/tools/list_changed", () => {
                  const task = Effect.runPromiseWith(telemetry.context)(
                    changed.pipe(
                      Effect.timeout("5 seconds"),
                      Effect.catchCause(() => Effect.logWarning("MCP catalog invalidation failed")),
                    ),
                  );
                  pending.add(task);
                  return task.finally(() => pending.delete(task));
                });
              }
              return {
                client,
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
                client.removeNotificationHandler("notifications/tools/list_changed");
                yield* Effect.promise(async () => {
                  await Promise.allSettled(pending);
                });
                if (
                  transport instanceof StreamableHTTPClientTransport &&
                  transport.sessionId !== undefined
                ) {
                  yield* Effect.tryPromise(() => transport.terminateSession()).pipe(
                    Effect.timeout(defaultMcpClientLimits.cleanupTimeoutMs),
                    Effect.ignore,
                  );
                }
                yield* Effect.tryPromise(async () => {
                  // Auto negotiation probes before Client owns the transport.
                  // Closing it explicitly also aborts an interrupted discovery probe.
                  try {
                    await transport.close();
                  } finally {
                    await client.close();
                  }
                }).pipe(Effect.timeout(defaultMcpClientLimits.cleanupTimeoutMs), Effect.ignore);
              }).pipe(Effect.withSpan("provider.mcp.close")),
          );
          yield* Effect.tryPromise({
            try: (signal) => client.connect(transport, { signal, timeout: connection.timeoutMs }),
            catch: (error) => {
              const projected = failure("connect", error);
              return Schema.is(McpError)(projected) && kind === "http"
                ? new McpError({ ...projected, initialized })
                : projected;
            },
          }).pipe(
            Effect.raceFirst(Deferred.await(rejected)),
            Effect.timeout(connection.timeoutMs),
            Effect.catchTag("TimeoutError", () =>
              Effect.fail(new McpError({ phase: "connect", reason: "timeout" })),
            ),
            Effect.mapError((error) =>
              original === undefined
                ? error
                : new McpError({
                    ...original,
                    fallback: {
                      phase: Schema.is(McpError)(error) ? error.phase : "connect",
                      reason: Schema.is(McpError)(error) ? error.reason : "request",
                      ...(error.status === undefined ? {} : { status: error.status }),
                    },
                  }),
            ),
            Effect.withSpan("provider.mcp.connect"),
          );
          pendingFallback = undefined;
          return yield* use(client).pipe(Effect.raceFirst(Deferred.await(rejected)));
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
      Effect.catchIf(
        (error): error is Extract<typeof error, McpError> =>
          Schema.is(McpError)(error) &&
          error.phase === "connect" &&
          (error.status === 404 || error.status === 405),
        (error) => {
          pendingFallback = error;
          return attempt("sse", error);
        },
      ),
      (operation) =>
        mode === "discover" ? operation.pipe(Effect.timeout(connection.timeoutMs)) : operation,
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          new McpError(
            pendingFallback === undefined
              ? { phase: "transport", reason: "timeout" }
              : { ...pendingFallback, fallback: { phase: "connect", reason: "timeout" } },
          ),
        ),
      ),
    );
  });
}

/** Discover and call with a fresh selected-account transport for each operation. */
export const mcpClientEffect = Effect.fn("Mcp.client")(function* (
  input: McpToolsOptions,
  changed?: Effect.Effect<void, unknown>,
) {
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
  return mcpClient(
    (mode, use) =>
      withClient(connection, mode, use, changed).pipe(
        Effect.mapError((error) =>
          options.accountId === undefined ? error : accountProviderError(error, options.accountId),
        ),
      ),
    connection.timeoutMs,
    failure,
  );
});

/** Discover and compile all tools for connection probes and low-level consumers. */
export const mcpToolsEffect = (input: McpToolsOptions) =>
  mcpClientEffect(input).pipe(Effect.flatMap(adaptMcpTools));
