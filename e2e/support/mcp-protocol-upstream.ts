/** Real upstream MCP runtimes with payload-free protocol observations. */
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Context, Effect, Layer, Match, Queue, Schema, Stream } from "effect";
import { McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/unstable/ai";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

class FixtureRequestFailed extends Schema.TaggedError<FixtureRequestFailed>()(
  "FixtureRequestFailed",
  {},
) {}

const Message = Schema.fromJsonString(
  Schema.Struct({
    method: Schema.String,
    id: Schema.optionalKey(Schema.Json),
    params: Schema.optionalKey(Schema.Json),
  }),
);
const toolkit = Toolkit.make(
  Tool.make("echo", {
    description: "Echo a value",
    parameters: Schema.Struct({ value: Schema.String }),
    success: Schema.Struct({ value: Schema.String }),
  }),
);

export const mcpProtocolUpstream = Effect.fn("McpProtocolUpstream.start")(function* () {
  const requests: { method: string; protocol: string | null; runtime: number; status: number }[] =
    [];
  const startRuntime = Effect.fn("McpProtocolUpstream.runtime")(function* () {
    const server = McpServer.layerHttp({
      name: "Protocol fixture",
      version: "1",
      path: "/mcp",
      protocols: [McpProtocol.v2026_07_28, McpProtocol.v2025_06_18],
    });
    const registration = Layer.effectDiscard(
      Effect.fn("McpProtocolUpstream.register")(function* () {
        yield* McpServer.registerToolkit(toolkit);
        const registry = yield* McpServer.McpServer;
        yield* registry.addTool({
          tool: new McpSchema.Tool({
            name: "confirm",
            description: "Confirm fixture request",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            outputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          }),
          annotations: Context.empty(),
          handle: Effect.fn("McpProtocolUpstream.confirm")(function* () {
            const request = yield* McpSchema.McpRequestContext;
            return Match.value(
              request.requestState === "fixture-confirmation" &&
                request.inputResponses?.confirmation?.action === "accept",
            ).pipe(
              Match.when(
                true,
                () =>
                  new McpSchema.CallToolResult({
                    content: [{ type: "text", text: "accepted" }],
                    structuredContent: { value: "accepted" },
                  }),
              ),
              Match.orElse(
                () =>
                  new McpSchema.InputRequired({
                    requestState: "fixture-confirmation",
                    inputRequests: {
                      confirmation: {
                        method: "elicitation/create",
                        params: {
                          mode: "form",
                          message: "Confirm fixture request",
                          requestedSchema: { type: "object", properties: {} },
                        },
                      },
                    },
                  }),
              ),
            );
          }),
        });
      })(),
    ).pipe(
      Layer.provide(toolkit.toLayer({ echo: (input) => Effect.succeed(input) })),
      Layer.provideMerge(server),
    );
    const memoMap = yield* Layer.makeMemoMap;
    return yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(registration, { disableLogger: true, memoMap })),
      (runtime) => Effect.promise(() => runtime.dispose()),
    );
  });
  const first = yield* startRuntime();
  const second = yield* startRuntime();
  let nextRuntime = 0;
  const stalled = { active: 0, closed: 0 };
  const handle = Effect.fn("McpProtocolUpstream.request")(function* (
    mode: "modern" | "legacy" | "session-loss" | "missing",
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const web = yield* HttpServerRequest.toWeb(request);
    const protocol = web.headers.get("mcp-protocol-version");
    const text = request.method === "POST" ? yield* request.text : undefined;
    const message =
      text === undefined ? undefined : yield* Schema.decodeUnknownEffect(Message)(text);
    const runtime = mode === "modern" || mode === "session-loss" ? nextRuntime++ % 2 : 0;
    const response = yield* Effect.gen(function* () {
      if (mode === "missing")
        return HttpServerResponse.text("upstream-body-secret", {
          status: request.method === "POST" ? 404 : 405,
        });
      if ((mode === "legacy" || mode === "session-loss") && message?.method === "server/discover")
        return yield* HttpServerResponse.json({
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: { code: -32601, message: "Method not found" },
        });
      const url = new URL(web.url);
      url.pathname = "/mcp";
      const forwarded = new Request(url, {
        method: web.method,
        headers: web.headers,
        ...(text === undefined ? {} : { body: text }),
      });
      const selected = runtime === 0 ? first : second;
      return HttpServerResponse.fromWeb(
        yield* Effect.tryPromise({
          try: (signal) => selected.handler(new Request(forwarded, { signal })),
          catch: () => new FixtureRequestFailed({}),
        }),
      );
    });
    requests.push({
      method: message?.method ?? request.method,
      protocol,
      runtime,
      status: response.status,
    });
    return response;
  });
  const messages = yield* Queue.unbounded<Uint8Array>();
  yield* Effect.addFinalizer(() => Queue.shutdown(messages));
  const encoder = new TextEncoder();
  const sseGet = Effect.fn("McpProtocolUpstream.sseConnect")(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    yield* Queue.clear(messages);
    requests.push({
      method: "GET",
      protocol: request.headers["mcp-protocol-version"] ?? null,
      runtime: 0,
      status: 200,
    });
    return HttpServerResponse.stream(
      Stream.make(encoder.encode("event: endpoint\ndata: /sse/messages\n\n")).pipe(
        Stream.concat(Stream.fromQueue(messages)),
      ),
      { contentType: "text/event-stream" },
    );
  });
  const ssePost = Effect.fn("McpProtocolUpstream.ssePost")(function* (endpoint: boolean) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const message = yield* request.text.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Message)));
    const status = endpoint ? 405 : 202;
    requests.push({
      method: message.method,
      protocol: request.headers["mcp-protocol-version"] ?? null,
      runtime: 0,
      status,
    });
    if (endpoint) return HttpServerResponse.empty({ status });
    if (message.id === undefined) return HttpServerResponse.empty({ status });
    const response = Match.value(message.method).pipe(
      Match.when("initialize", () => ({
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "SSE fixture", version: "1" },
        },
      })),
      Match.when("tools/list", () => ({
        result: {
          tools: [
            {
              name: "echo",
              description: "Echo a value",
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
              },
            },
          ],
        },
      })),
      Match.when("tools/call", () => ({
        result: {
          content: [{ type: "text", text: "SSE echo" }],
          structuredContent: { value: "sse" },
        },
      })),
      Match.orElse(() => ({ error: { code: -32601, message: "Method not found" } })),
    );
    yield* Queue.offer(
      messages,
      encoder.encode(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...response })}\n\n`,
      ),
    );
    return HttpServerResponse.empty({ status });
  });
  const fallbackMissing = Effect.fn("McpProtocolUpstream.fallbackMissing")(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const message = yield* request.text.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Message)));
    requests.push({
      method: message.method,
      protocol: request.headers["mcp-protocol-version"] ?? null,
      runtime: 0,
      status: 404,
    });
    return HttpServerResponse.text("upstream-body-secret", { status: 404 });
  });
  const fallbackStall = Effect.fn("McpProtocolUpstream.fallbackStall")(function* () {
    stalled.active++;
    return yield* Effect.never.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          stalled.active--;
          stalled.closed++;
        }),
      ),
    );
  });
  const routes = Layer.mergeAll(
    HttpRouter.add("GET", "/fallback-stall", fallbackStall()),
    HttpRouter.add("POST", "/fallback-stall", fallbackMissing().pipe(Effect.orDie)),
    HttpRouter.add(
      "POST",
      "/stall",
      Effect.suspend(() => {
        stalled.active++;
        return Effect.never.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              stalled.active--;
              stalled.closed++;
            }),
          ),
        );
      }),
    ),
    HttpRouter.add("GET", "/sse", sseGet().pipe(Effect.orDie)),
    HttpRouter.add("POST", "/sse", ssePost(true).pipe(Effect.orDie)),
    HttpRouter.add("POST", "/sse/messages", ssePost(false).pipe(Effect.orDie)),
    HttpRouter.add("POST", "/modern", handle("modern").pipe(Effect.orDie)),
    HttpRouter.add("GET", "/modern", handle("modern").pipe(Effect.orDie)),
    ...(["legacy", "session-loss", "missing"] as const).flatMap((mode) => [
      HttpRouter.add("POST", `/${mode}`, handle(mode).pipe(Effect.orDie)),
      HttpRouter.add("GET", `/${mode}`, handle(mode).pipe(Effect.orDie)),
    ]),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("MCP fixture requires a TCP listener");
  return { origin: `http://127.0.0.1:${server.address.port}`, requests, stalled };
});
