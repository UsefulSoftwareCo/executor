/** A public MCP server whose tools carry each approval-relevant hint; it records every call. */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Ref, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";

const Message = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String,
  params: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })),
});

/** Tool name to upstream annotations. `unhinted` declares none. */
export const approvalMcpTools = {
  read: { readOnlyHint: true },
  safe: { destructiveHint: false },
  unhinted: undefined,
  erase: { destructiveHint: true },
  conflict: { readOnlyHint: true, destructiveHint: true },
} as const;

/** Start the server for the case scope. `calls` lists the tool names the server actually ran. */
export const approvalMcpUpstream = Effect.gen(function* () {
  const calls = yield* Ref.make<readonly string[]>([]);
  const tools = Object.entries(approvalMcpTools).map(([name, annotations]) => ({
    name,
    description: `Fixture tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    ...(annotations === undefined ? {} : { annotations }),
  }));
  const routes = Layer.mergeAll(
    HttpRouter.add("GET", "/mcp", HttpServerResponse.empty({ status: 405 })),
    HttpRouter.add(
      "POST",
      "/mcp",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const message = yield* request.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Message)),
        );
        if (message.id === undefined) return HttpServerResponse.empty({ status: 202 });
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "approvals", version: "1" },
              }
            : message.method === "tools/list"
              ? { tools }
              : yield* Effect.gen(function* () {
                  const name = message.params?.name ?? "";
                  yield* Ref.update(calls, (previous) => [...previous, name]);
                  return { content: [{ type: "text", text: `ran ${name}` }] };
                });
        return yield* HttpServerResponse.json({ jsonrpc: "2.0", id: message.id, result });
      }),
    ),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return { origin: `http://127.0.0.1:${server.address.port}`, calls: Ref.get(calls) };
});
