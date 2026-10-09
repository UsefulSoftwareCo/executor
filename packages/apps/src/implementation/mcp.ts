import { httpProviderError, accountProviderError, providerErrorDetail } from "./provider-error.ts";
import { ProviderError } from "../contracts/provider-error.ts";
import type { UpstreamError } from "../contracts/failure.ts";
import { bodyUpstreamError } from "./upstream-error.ts";
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
import { captureTelemetry, owned } from "@executor-js/telemetry";
import {
  Clock,
  Deferred,
  Effect,
  Match,
  Option,
  Predicate,
  Redacted,
  Ref,
  Schema,
  Stream,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import {
  defaultMcpClientLimits,
  McpCredentialsUnverified,
  McpError,
  McpHealthInput,
  mcpHealthReserveMs,
  McpToolsOptions,
  type McpConnection,
  type McpHealthCheck,
  type McpHealthOptions,
} from "../contracts/mcp.ts";
import { adaptMcpTools } from "./mcp-tools.ts";
import { NetworkRefused } from "../contracts/network.ts";
import { failOnNetworkRefusal } from "./network.ts";
import { answeredError, mcpClient, mcpJsonSchemaValidator } from "./mcp-client.ts";

/**
 * The client rejects a body that is not JSON with a `SyntaxError`, and a message that does not
 * match the protocol's schema with a Zod error listing its `issues`.
 */
const unreadable = (error: unknown) =>
  error instanceof SyntaxError ||
  (error instanceof Error && Predicate.hasProperty(error, "issues") && Array.isArray(error.issues));

/**
 * Safe projection of client errors. Raw messages can contain credential-bearing URLs. Only a status
 * the server redirected or failed the request with is kept: the client also reports `-1` for a
 * response that is not MCP, and the `200` of a web page served where an SSE stream was expected.
 * A JSON-RPC error the server answered with, kept as `upstream`, or a closed connection, is
 * `request` without a status.
 */
const failure = (
  phase: McpError["phase"],
  error: unknown,
): McpError | ProviderError | NetworkRefused => {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  let timedOut = false;
  let invalidResponse = false;
  for (let depth = 0; pending.length > 0 && depth < 16; depth++) {
    const cause = pending.shift();
    if (seen.has(cause)) continue;
    seen.add(cause);
    if (
      Schema.is(ProviderError)(cause) ||
      Schema.is(McpError)(cause) ||
      Schema.is(NetworkRefused)(cause)
    )
      return cause;
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
    if (status !== undefined && status >= 300 && status <= 599)
      return httpProviderError(status) ?? new McpError({ phase, reason: "request", status });
    if (cause instanceof SdkError && cause.code === SdkErrorCode.RequestTimeout) timedOut = true;
    if (
      unreadable(cause) ||
      (status !== undefined && (status < 300 || status > 599)) ||
      (cause instanceof SdkError &&
        (cause.code === SdkErrorCode.InvalidResult ||
          cause.code === SdkErrorCode.ClientHttpUnexpectedContent))
    )
      invalidResponse = true;
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
  const upstream = answeredError(error);
  return new McpError({
    phase,
    reason: timedOut ? "timeout" : invalidResponse ? "invalid_response" : "request",
    ...(upstream === undefined ? {} : { upstream }),
  });
};

/**
 * An error response of a session: the error its JSON body stated, if any, and whether the refused
 * request carried the session ID the server issued.
 */
interface ErrorResponse {
  readonly upstream: UpstreamError | undefined;
  readonly session: boolean;
}

/**
 * The latest error response of a session with each status. The client reports only a refused
 * request's status, and other requests of the session, such as its optional event stream, can
 * be refused meanwhile with another status.
 */
type ErrorResponses = ReadonlyMap<number, ErrorResponse>;

/** Error bodies are small: read at most this much, for at most this long. */
const errorBodyLimits = { maxBytes: 65_536, readTimeoutMs: 2_000 } as const;

/**
 * A bounded copy of a JSON error body, so the error it states can be reported and the SDK still
 * reads the same body. Other bodies are left unread; an unreadable one becomes empty.
 */
const errorBody = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const json = /^application\/(?:[\w.-]+\+)?json$/i.test(
      response.headers["content-type"]?.split(";")[0]?.trim() ?? "",
    );
    const length = response.headers["content-length"];
    if (!json || (length !== undefined && Number(length) > errorBodyLimits.maxBytes))
      return { body: Stream.toReadableStream(response.stream), upstream: undefined };
    // An unreadable, oversized or stalled body states nothing; the refusal keeps its status.
    const unreadable = new McpError({ phase: "transport", reason: "invalid_response" });
    const read = yield* response.stream.pipe(
      Stream.mapError(() => unreadable),
      Stream.limitBytes(errorBodyLimits.maxBytes, () => Stream.fail(unreadable)),
      Stream.decodeText,
      Stream.mkString,
      Effect.timeout(errorBodyLimits.readTimeoutMs),
      Effect.option,
    );
    if (Option.isNone(read)) return { body: null, upstream: undefined };
    const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(read.value);
    return {
      body: read.value,
      upstream: Option.isSome(parsed) ? bodyUpstreamError(parsed.value) : undefined,
    };
  });

const sentMethod = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ method: Schema.String })),
);

// The library consumes Web Responses; Effect owns requests and streaming bodies.
// Retain the transport abort signal after response headers arrive.
const transportFetch =
  (
    connection: McpConnection,
    telemetry: Effect.Success<typeof captureTelemetry>,
    rejected: Deferred.Deferred<never, ProviderError | NetworkRefused>,
    answered: Ref.Ref<ErrorResponses>,
    initialized: () => void,
  ): FetchLike =>
  (url, init) =>
    Effect.runPromiseWith(telemetry.context)(
      Effect.gen(function* () {
        if (
          Option.exists(
            sentMethod(init?.body),
            (message) => message.method === "notifications/initialized",
          )
        )
          initialized();
        // Executor's own refusals name the setting or server response at fault, never a network failure.
        const target = yield* Effect.try({
          try: () => new URL(url),
          catch: () => new McpError({ phase: "transport", reason: "invalid_response" }),
        });
        if (connection.url.username || connection.url.password)
          return yield* new McpError({ phase: "transport", reason: "invalid_input" });
        // The server directed the client to another origin or embedded credentials in a URL.
        if (target.origin !== connection.url.origin || target.username || target.password)
          return yield* new McpError({ phase: "transport", reason: "invalid_response" });
        const request = yield* Effect.try({
          try: () => {
            const headers = new Headers(Redacted.value(connection.headers));
            new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
            return HttpClientRequest.fromWeb(new Request(target, { ...init, headers }));
          },
          // The provider's headers cannot form an HTTP request, such as a name with a space.
          catch: () => new McpError({ phase: "transport", reason: "invalid_input" }),
        });
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.execute(request);
        // Executor's network refused the request; its reason names the host or credential at fault.
        yield* failOnNetworkRefusal(response).pipe(
          Effect.tapError((refused) => Deferred.fail(rejected, refused)),
        );
        if (response.status < 400)
          return new Response(
            [204, 205, 304].includes(response.status)
              ? null
              : Stream.toReadableStream(response.stream),
            {
              status: response.status,
              headers: response.headers,
            },
          );
        const { body, upstream } = yield* errorBody(response);
        const provider = httpProviderError(response.status, response.headers);
        if (provider !== undefined) {
          // EventSource replaces rejected fetch errors. Retain our safe failure
          // within this session so SSE cannot erase its status or reason.
          const refused = providerErrorDetail(provider, { upstream });
          yield* Deferred.fail(rejected, refused);
          return yield* refused;
        }
        // The SDK reports only the status of a refused request; keep the error the body stated.
        // Only the Streamable HTTP transport sends the session ID its server issued.
        const session = new Headers(init?.headers).has("mcp-session-id");
        yield* Ref.update(answered, (responses) =>
          new Map(responses).set(response.status, { upstream, session }),
        );
        return new Response(body, { status: response.status, headers: response.headers });
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

/**
 * Name the phase a provider failure happened in, and give a refused request the error its
 * response stated and whether it carried the server's session. Session setup is `connect`; the
 * operation itself is the session's mode.
 */
const explain = <E>(
  error: E,
  phase: "connect" | "discover" | "call",
  responses: ErrorResponses,
) => {
  if (Schema.is(ProviderError)(error)) return providerErrorDetail(error, { phase });
  if (!Schema.is(McpError)(error) || error.status === undefined) return error;
  const response = responses.get(error.status);
  if (
    response === undefined ||
    ((error.upstream !== undefined || response.upstream === undefined) && !response.session)
  )
    return error;
  const upstream = error.upstream ?? response.upstream;
  return new McpError({
    ...error,
    phase: error.phase,
    reason: error.reason,
    status: error.status,
    ...(upstream === undefined ? {} : { upstream }),
    ...(response.session ? { session: true } : {}),
  });
};

/** Fail with the explained error, reading the session's error response with its status. */
const explained =
  (phase: "connect" | "discover" | "call", answered: Ref.Ref<ErrorResponses>) =>
  <E>(error: E) =>
    Ref.get(answered).pipe(
      Effect.flatMap((responses) => Effect.fail(explain(error, phase, responses))),
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
          const rejected = yield* Deferred.make<never, ProviderError | NetworkRefused>();
          const answered = yield* Ref.make<ErrorResponses>(new Map());
          const pending = new Set<Promise<void>>();
          let initialized = false;
          const { client, transport } = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const fetch = transportFetch(connection, telemetry, rejected, answered, () => {
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
                  // oxlint-disable-next-line executor/authored-code-through-adapter -- Executor catalog invalidation
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
                // oxlint-disable-next-line executor/authored-code-through-adapter -- Executor catalog invalidations
                yield* Effect.promise(async () => {
                  await Promise.allSettled(pending);
                });
                if (
                  transport instanceof StreamableHTTPClientTransport &&
                  transport.sessionId !== undefined
                ) {
                  // oxlint-disable-next-line executor/authored-code-through-adapter -- MCP SDK
                  yield* Effect.tryPromise(() => transport.terminateSession()).pipe(
                    Effect.timeout(defaultMcpClientLimits.cleanupTimeoutMs),
                    Effect.ignore,
                  );
                }
                // oxlint-disable-next-line executor/authored-code-through-adapter -- MCP SDK
                yield* Effect.tryPromise(async () => {
                  // Auto negotiation probes before Client owns the transport.
                  // Closing it explicitly also aborts an interrupted discovery probe.
                  try {
                    await transport.close();
                  } finally {
                    await client.close();
                  }
                }).pipe(Effect.timeout(defaultMcpClientLimits.cleanupTimeoutMs), Effect.ignore);
              }).pipe(owned("upstream", "provider.mcp.close")),
          );
          // oxlint-disable-next-line executor/authored-code-through-adapter -- MCP SDK
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
            Effect.catch(explained("connect", answered)),
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
                      ...(Schema.is(McpError)(error) || Schema.is(ProviderError)(error)
                        ? error.status === undefined
                          ? {}
                          : { status: error.status }
                        : {}),
                    },
                  }),
            ),
            owned("upstream", "provider.mcp.connect"),
          );
          pendingFallback = undefined;
          return yield* use(client).pipe(
            Effect.raceFirst(Deferred.await(rejected)),
            Effect.catch(explained(mode, answered)),
          );
        }),
      ).pipe(
        owned("upstream", "provider.mcp.session", {
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
export const mcpClientEffect = (input: McpToolsOptions, changed?: Effect.Effect<void, unknown>) =>
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
    return mcpClient(
      (mode, use) =>
        withClient(connection, mode, use, changed).pipe(
          Effect.mapError((error) =>
            options.accountId === undefined
              ? error
              : accountProviderError(error, options.accountId),
          ),
        ),
      connection.timeoutMs,
      failure,
    );
  });

/**
 * Whether the server refused a check for lacking credentials: a 401, or a 403 that is not rate
 * limiting, whether it came at initialization or while listing tools.
 */
const refusesCredentials = (error: McpError | ProviderError) =>
  Schema.is(ProviderError)(error) &&
  Match.value(error.reason).pipe(
    Match.whenOr("unauthorized", "forbidden", "rejected", () => true),
    Match.whenOr("rate_limited", "unavailable", () => false),
    Match.exhaustive,
  );

/**
 * Check one account: initialize and read the first page of tools with the account's headers, then
 * repeat that with no headers on a fresh transport. A refused account fails with its
 * `ProviderError`, and anything else that stops the first check is an `McpError`; the second never
 * runs. The check passes only when the server refuses the second, which shows it checked the
 * credentials. Otherwise it fails with `McpCredentialsUnverified`. Both share one budget, which
 * ends early enough before the check context's deadline to close the session and report why.
 */
export const mcpHealthEffect = (check: McpHealthCheck, options: McpHealthOptions) =>
  Effect.gen(function* () {
    const { deadline, timeoutMs, ...parsed } = yield* Schema.decodeUnknownEffect(McpHealthInput)({
      ...options,
      accountId: check.account.id,
      signal: check.signal,
      deadline: check.deadline,
    }).pipe(Effect.mapError(() => new McpError({ phase: "connect", reason: "invalid_input" })));
    const end = Math.min(
      (yield* Clock.currentTimeMillis) + (timeoutMs ?? defaultMcpClientLimits.timeoutMs),
      deadline === undefined ? Number.POSITIVE_INFINITY : deadline - mcpHealthReserveMs,
    );
    /** What is left of the budget for the next attempt; a timeout once it is spent. */
    const remaining = Effect.flatMap(Clock.currentTimeMillis, (now) =>
      end - now >= 1
        ? Effect.succeed(Math.floor(end - now))
        : Effect.fail(new McpError({ phase: "transport", reason: "timeout" })),
    );
    yield* (yield* mcpClientEffect({ ...parsed, timeoutMs: yield* remaining })).check;
    // The same server, limits and budget; nothing derived from the account.
    return yield* remaining.pipe(
      Effect.flatMap((timeoutMs) =>
        mcpClientEffect({ url: parsed.url, signal: parsed.signal, timeoutMs }),
      ),
      Effect.flatMap((anonymous) => anonymous.check),
      Effect.matchEffect({
        onSuccess: () => Effect.fail(new McpCredentialsUnverified({ anonymous: "answered" })),
        // Executor's network refused the attempt, so the server never answered it.
        onFailure: (error): Effect.Effect<void, McpCredentialsUnverified | NetworkRefused> =>
          Schema.is(NetworkRefused)(error)
            ? Effect.fail(error)
            : refusesCredentials(error)
              ? Effect.void
              : Effect.fail(new McpCredentialsUnverified({ anonymous: error })),
      }),
      owned("upstream", "provider.mcp.anonymous"),
    );
  }).pipe(owned("upstream", "provider.mcp.health"));

/** Discover and compile all tools for connection probes and low-level consumers. */
export const mcpToolsEffect = (input: McpToolsOptions) =>
  mcpClientEffect(input).pipe(Effect.flatMap(adaptMcpTools));
