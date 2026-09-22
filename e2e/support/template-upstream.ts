/** Synthetic upstream protocols; the product still generates, deploys and calls real apps. */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { createServer } from "node:http";

const Message = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String,
});
const identity = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const credential = yield* Schema.decodeUnknownEffect(
    Schema.Literals(["Bearer synthetic-work", "Bearer synthetic-personal"]),
  )(request.headers.authorization);
  return credential === "Bearer synthetic-work" ? "work" : "personal";
});
const output = {
  type: "object",
  properties: { account: { type: "string" } },
  required: ["account"],
};

/** Start isolated OpenAPI, MCP and GraphQL endpoints; close the listener with the case scope. */
export const templateUpstream = Effect.gen(function* () {
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/openapi.json",
      HttpServerResponse.json({
        openapi: "3.0.3",
        info: { title: "Account fixture", version: "1" },
        components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
        security: [{ bearer: [] }],
        paths: {
          "/identity": {
            get: {
              operationId: "identity",
              responses: {
                "200": {
                  description: "Current account",
                  content: { "application/json": { schema: output } },
                },
              },
            },
          },
        },
      }),
    ),
    HttpRouter.add(
      "GET",
      "/identity",
      Effect.gen(function* () {
        return yield* HttpServerResponse.json({ account: yield* identity });
      }),
    ),
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
        const account = yield* identity;
        const tool = {
          name: "identity",
          description: "Read the selected account",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: { value: { $ref: "#/$defs/Value" } },
            $defs: { Value: { type: "string", const: account } },
            required: ["value"],
          },
          outputSchema: {
            ...output,
            properties: { account: { $ref: "#/$defs/Account" } },
            $defs: { Account: { type: "string" } },
          },
        };
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "accounts", version: "1" },
              }
            : message.method === "tools/list"
              ? { tools: [tool] }
              : { content: [{ type: "text", text: account }], structuredContent: { account } };
        return yield* HttpServerResponse.json({ jsonrpc: "2.0", id: message.id, result });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/graphql",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { query } = yield* request.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ query: Schema.String }))),
        );
        const scalar = { kind: "SCALAR", name: "String", ofType: null };
        const data = query.includes("__schema")
          ? {
              __schema: {
                queryType: { name: "Query" },
                mutationType: null,
                types: [
                  {
                    kind: "OBJECT",
                    name: "Query",
                    inputFields: null,
                    enumValues: null,
                    fields: [
                      {
                        name: "identity",
                        description: "Read the selected account",
                        args: [],
                        type: scalar,
                      },
                    ],
                  },
                  {
                    kind: "SCALAR",
                    name: "String",
                    fields: null,
                    inputFields: null,
                    enumValues: null,
                  },
                ],
              },
            }
          : { identity: yield* identity };
        return yield* HttpServerResponse.json({ data });
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
  return `http://127.0.0.1:${server.address.port}`;
});
