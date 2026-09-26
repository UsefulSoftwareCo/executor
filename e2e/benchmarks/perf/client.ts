/** Timed product clients: every request carries a sampled traceparent and records Server-Timing. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { randomBytes } from "node:crypto";

export class PerfRequestFailed extends Schema.TaggedError<PerfRequestFailed>()(
  "PerfRequestFailed",
  { operation: Schema.String, status: Schema.optional(Schema.Number), detail: Schema.String },
) {}

/** One measured exchange. `serverMs` is the handler duration the product reports. */
export interface Timed {
  readonly status: number;
  readonly body: unknown;
  readonly clientMs: number;
  readonly serverMs: number | undefined;
  readonly traceId: string;
}

/** Parse `executor;dur=N` and `executor-trace;desc="..."` from Server-Timing. */
export const serverTiming = (header: string | null | undefined) => {
  if (!header) return { serverMs: undefined, traceId: undefined };
  const dur = /(?:^|,)\s*executor;dur=([\d.]+)/.exec(header)?.[1];
  const trace = /executor-trace;desc="([a-f0-9]{32})"/.exec(header)?.[1];
  return { serverMs: dur === undefined ? undefined : Number(dur), traceId: trace };
};

export const newTrace = () => {
  const traceId = randomBytes(16).toString("hex");
  return { traceId, traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01` };
};

/** Cookie header for a synthetic fixture session. */
export const cookieHeader = (cookies: readonly { name: string; value: string }[]) =>
  cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Product HTTP client bound to one origin and one actor's cookies. */
export const productClient = (origin: string, cookies: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const request = (method: Method, path: string, data?: unknown) =>
      Effect.gen(function* () {
        const url = new URL(path, origin);
        if (url.origin !== origin)
          return yield* new PerfRequestFailed({
            operation: path,
            detail: "cross-origin request rejected",
          });
        const trace = newTrace();
        let outgoing = HttpClientRequest.make(method)(url, {
          headers: { cookie: cookies, origin, traceparent: trace.traceparent },
        });
        if (data !== undefined) outgoing = yield* HttpClientRequest.bodyJson(outgoing, data);
        const started = performance.now();
        const response = yield* http.execute(outgoing);
        const text = yield* response.text;
        const clientMs = performance.now() - started;
        const timing = serverTiming(response.headers["server-timing"]);
        let body: unknown = text;
        if (text.length > 0 && (response.headers["content-type"] ?? "").includes("json"))
          body = yield* Effect.try({
            try: () => JSON.parse(text) as unknown,
            catch: () =>
              new PerfRequestFailed({ operation: path, status: response.status, detail: "json" }),
          });
        return {
          status: response.status,
          body,
          clientMs,
          serverMs: timing.serverMs,
          traceId: timing.traceId ?? trace.traceId,
        } satisfies Timed;
      }).pipe(
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.timeout("120 seconds"),
        Effect.mapError((cause) =>
          Schema.is(PerfRequestFailed)(cause)
            ? cause
            : new PerfRequestFailed({ operation: `${method} ${path}`, detail: String(cause) }),
        ),
      );
    return { origin, request };
  });
export type ProductClient = Effect.Success<ReturnType<typeof productClient>>;

/** One MCP HTTP exchange as observed by the protocol client. */
export interface McpExchange {
  readonly method: string;
  readonly httpMethod: string;
  readonly status: number;
  readonly clientMs: number;
  readonly serverMs: number | undefined;
  readonly traceId: string;
}

/**
 * Official MCP client whose fetch records every exchange. Headers are never logged; the PAT stays
 * in memory. `exchanges` is appended to as requests complete.
 */
export const mcpSession = (origin: string, token: string, organization: string) =>
  Effect.gen(function* () {
    const exchanges: McpExchange[] = [];
    const observed: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      const trace = newTrace();
      request.headers.set("traceparent", trace.traceparent);
      const started = performance.now();
      const methodPromise =
        request.method === "POST"
          ? request
              .clone()
              .text()
              .then((text) => {
                const parsed = Schema.decodeUnknownOption(
                  Schema.fromJsonString(Schema.Struct({ method: Schema.optional(Schema.String) })),
                )(text);
                return parsed._tag === "Some" ? (parsed.value.method ?? "response") : "batch";
              })
          : Promise.resolve(request.method);
      return methodPromise.then((method) =>
        fetch(request).then((response) => {
          const timing = serverTiming(response.headers.get("server-timing"));
          const record = (clientMs: number) =>
            exchanges.push({
              method,
              httpMethod: request.method,
              status: response.status,
              clientMs,
              serverMs: timing.serverMs,
              traceId: timing.traceId ?? trace.traceId,
            });
          // Streamed responses complete when their body ends; record at that point.
          if (response.body === null) {
            record(performance.now() - started);
            return response;
          }
          const [measured, passed] = response.body.tee();
          void new Response(measured)
            .arrayBuffer()
            .then(() => record(performance.now() - started))
            .catch(() => record(performance.now() - started));
          return new Response(passed, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }),
      );
    };
    const client = new Client({ name: "executor-perf", version: "1" }, {});
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: {
        headers: { authorization: `Bearer ${token}`, "X-Executor-Organization": organization },
      },
      fetch: observed,
    });
    const compatible: Omit<StreamableHTTPClientTransport, "sessionId"> = transport;
    const started = performance.now();
    yield* Effect.tryPromise({
      try: () => client.connect(compatible),
      catch: (cause) => new PerfRequestFailed({ operation: "MCP connect", detail: String(cause) }),
    });
    const openMs = performance.now() - started;
    const close = Effect.gen(function* () {
      const at = performance.now();
      yield* Effect.tryPromise({
        try: () => transport.terminateSession().then(() => client.close()),
        catch: (cause) => new PerfRequestFailed({ operation: "MCP close", detail: String(cause) }),
      });
      return performance.now() - at;
    });
    const callTool = (name: string, args: Record<string, unknown>) =>
      Effect.gen(function* () {
        const before = exchanges.length;
        const at = performance.now();
        const result = yield* Effect.tryPromise({
          try: (signal) =>
            client.callTool({ name, arguments: args }, undefined, {
              signal,
              timeout: 120_000,
            }),
          catch: (cause) => {
            const last = exchanges.at(-1);
            return new PerfRequestFailed({
              operation: `MCP ${name}`,
              ...(last === undefined ? {} : { status: last.status }),
              detail: `${String(cause)}${last === undefined ? "" : ` (HTTP ${last.status}, trace ${last.traceId})`}`,
            });
          },
        });
        return { result, clientMs: performance.now() - at, exchanges: exchanges.slice(before) };
      });
    /** The product answered 404 for this session; spec clients must initialize a new one. */
    const lost = () => exchanges.at(-1)?.status === 404;
    return { openMs, close, callTool, exchanges, lost, sessionId: () => transport.sessionId };
  });
export type McpSession = Effect.Success<ReturnType<typeof mcpSession>>;
