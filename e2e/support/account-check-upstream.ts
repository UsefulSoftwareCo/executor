import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Ref, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";

/** The only token the fake service accepts. */
export const acceptedToken = "synthetic-check-token";

type Failure =
  | {
      readonly kind: "status";
      readonly status: number;
      readonly headers?: Record<string, string>;
    }
  | { readonly kind: "hang" };

/**
 * What the fake service answers. The rest apply only to the MCP server: `page` serves a web page
 * at its URL, answering POST with `post` when set, and `list-error` answers `tools/list` with a
 * JSON-RPC internal error. `protected` refuses every request without the accepted token with an
 * OAuth challenge, initialization included; `open` lists its tools for anyone, with or without a
 * token. `anonymous` gives only requests without credentials the `failure`.
 */
export type AccountCheckAnswer =
  | { readonly kind: "user" }
  | Failure
  | { readonly kind: "page"; readonly post?: number }
  | { readonly kind: "list-error" }
  | { readonly kind: "protected" }
  | { readonly kind: "open" }
  | { readonly kind: "anonymous"; readonly failure: Failure };

const McpMessage = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String,
});

/**
 * A synthetic service with one safe read, `GET /me`, and an MCP server at `/mcp`. `/me` returns a
 * synthetic user for the accepted token and 401 for any other token. The MCP server initializes
 * anyone but lists its tools only for the accepted token. Both answer the configured failure.
 * `anonymousRequests` counts the MCP requests that carried no credentials.
 */
export const accountCheckUpstream = Effect.gen(function* () {
  const answer = yield* Ref.make<AccountCheckAnswer>({ kind: "user" });
  const anonymousRequests = yield* Ref.make(0);
  const mcp = HttpRouter.add(
    "*",
    "/mcp",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const configured = yield* Ref.get(answer);
      const credentials = request.headers.authorization;
      if (credentials === undefined) yield* Ref.update(anonymousRequests, (count) => count + 1);
      const current =
        configured.kind !== "anonymous"
          ? configured
          : credentials === undefined
            ? configured.failure
            : ({ kind: "user" } as const);
      const authorized = credentials === `Bearer ${acceptedToken}`;
      if (current.kind === "hang") return yield* Effect.never;
      if (current.kind === "status")
        return yield* HttpServerResponse.json(
          { message: "synthetic failure" },
          { status: current.status, headers: current.headers },
        );
      if (current.kind === "page")
        return request.method === "POST" && current.post !== undefined
          ? HttpServerResponse.empty({ status: current.post })
          : HttpServerResponse.html("<!doctype html><title>Synthetic page</title>");
      if (current.kind === "protected" && !authorized)
        return yield* HttpServerResponse.json(
          { error: "invalid_token" },
          {
            status: 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata="http://${request.headers.host}/.well-known/oauth-protected-resource/mcp"`,
            },
          },
        );
      // No standalone event stream.
      if (request.method !== "POST") return HttpServerResponse.empty({ status: 405 });
      const message = yield* request.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(McpMessage)),
      );
      if (message.id === undefined) return HttpServerResponse.empty({ status: 202 });
      if (message.method === "initialize")
        return yield* HttpServerResponse.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "checked-service", version: "1" },
          },
        });
      if (!authorized && current.kind !== "open")
        return yield* HttpServerResponse.json({ message: "unauthorized" }, { status: 401 });
      if (current.kind === "list-error" && message.method === "tools/list")
        return yield* HttpServerResponse.json({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: "Synthetic internal error" },
        });
      return yield* HttpServerResponse.json({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: [] },
      });
    }),
  );
  const me = HttpRouter.add(
    "GET",
    "/me",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const current = yield* Ref.get(answer);
      if (current.kind === "hang") return yield* Effect.never;
      if (current.kind === "status")
        return yield* HttpServerResponse.json(
          { message: "synthetic failure" },
          { status: current.status, headers: current.headers },
        );
      if (request.headers.authorization !== `Bearer ${acceptedToken}`)
        return yield* HttpServerResponse.json({ message: "unauthorized" }, { status: 401 });
      return yield* HttpServerResponse.json({
        id: "user-4242",
        name: "Synthetic Person",
        login: "synthetic-person",
        avatar: "https://avatars.example.test/u/4242.png",
      });
    }),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(Layer.mergeAll(me, mcp), { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return {
    origin: `http://127.0.0.1:${server.address.port}`,
    answer: (value: AccountCheckAnswer) => Ref.set(answer, value),
    anonymousRequests: Ref.get(anonymousRequests),
  };
});
