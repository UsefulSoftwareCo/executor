/** A synthetic upstream MCP endpoint, using only the public JSON-RPC wire contract. */
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

const Rpc = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String,
});

/** Return a real listener owned by the current test scope; no application services are replaced. */
export const mcpOutcomeFixture = Effect.gen(function* () {
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rpc = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Rpc)));
    if (rpc.id === undefined) return HttpServerResponse.empty({ status: 202 });
    const result =
      rpc.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "synthetic-outcomes", version: "1" },
          }
        : rpc.method === "tools/list"
          ? {
              tools: [
                {
                  name: "failure",
                  description: "Synthetic upstream tool failure",
                  inputSchema: { type: "object", properties: {} },
                  annotations: { readOnlyHint: true },
                },
              ],
            }
          : rpc.method === "tools/call"
            ? { isError: true, content: [{ type: "text", text: "Synthetic upstream failure" }] }
            : {};
    return HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: rpc.id, result });
  }).pipe(Effect.orDie);
  const services = yield* Layer.build(
    HttpRouter.serve(
      Layer.mergeAll(
        HttpRouter.add("POST", "/mcp", handler),
        HttpRouter.add("GET", "/ping", Effect.succeed(HttpServerResponse.text("ok"))),
      ),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address))
    return yield* Effect.die("The MCP fixture requires a TCP listener");
  return `http://127.0.0.1:${server.address.port}`;
});
