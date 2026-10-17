/** A remote MCP server that refuses the optional event stream still serves its tools. */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Layer, Ref, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { mcpSdkVersion, withApps } from "../support/apps-release.ts";

const JsonRpcRequest = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optional(Schema.Struct({ protocolVersion: Schema.optional(Schema.String) })),
});

/**
 * An MCP server that answers every POST but refuses the standalone GET event stream with a 401
 * and a JSON-RPC error, as some hosted servers do instead of the 405 the spec asks for. It holds
 * `tools/list` until that GET has arrived, so the refusal reaches the client during discovery.
 */
const refusedStreamMcpServer = Effect.gen(function* () {
  const requests = yield* Ref.make<ReadonlyArray<string>>([]);
  const streamRequested = yield* Deferred.make<void>();
  const answer = (id: string | number, result: object) =>
    HttpServerResponse.json({ jsonrpc: "2.0", id, result });
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method === "GET") {
      yield* Ref.update(requests, (seen) => [...seen, "GET 401"]);
      yield* Deferred.succeed(streamRequested, undefined);
      return yield* HttpServerResponse.json(
        {
          jsonrpc: "2.0",
          error: { code: -32600, message: "Authorization required" },
          id: null,
        },
        {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"`,
          },
        },
      );
    }
    if (request.method !== "POST") return HttpServerResponse.empty({ status: 405 });
    const message = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonRpcRequest))(
      yield* request.text,
    );
    yield* Ref.update(requests, (seen) => [...seen, `POST ${message.method}`]);
    if (message.id === undefined) return HttpServerResponse.empty({ status: 202 });
    switch (message.method) {
      case "initialize":
        return yield* answer(message.id, {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "Refused stream fixture", version: "1.0.0" },
        });
      case "tools/list":
        yield* Deferred.await(streamRequested).pipe(Effect.timeout("5 seconds"), Effect.ignore);
        return yield* answer(message.id, {
          tools: [
            {
              name: "ping",
              description: "Answer pong",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true },
            },
          ],
        });
      case "tools/call":
        return yield* answer(message.id, {
          content: [{ type: "text", text: "pong" }],
          structuredContent: { reply: "pong" },
        });
      default:
        return yield* HttpServerResponse.json({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
    }
  });
  const services = yield* Layer.build(
    HttpRouter.serve(HttpRouter.add("*", "/mcp", handler), {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return { url: `http://127.0.0.1:${server.address.port}/mcp`, requests: Ref.get(requests) };
});

const appFiles = (url: string) => [
  {
    path: "package.json",
    content: JSON.stringify({
      dependencies: withApps({ "@modelcontextprotocol/sdk": mcpSdkVersion }),
    }),
  },
  {
    path: "index.ts",
    content: `import { defineApp, router } from "apps";
import { mcpRouter } from "apps/mcp";
export default defineApp({}, async (ctx) => ({ tools: router({
  remote: await mcpRouter({ url: ${JSON.stringify(url)}, signal: ctx.signal }),
}) }));`,
  },
];

layer(HostedLive, { excludeTestServices: true })("MCP event stream", (it) => {
  it.effect(scenarios.mcpRefusedEventStream.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const server = yield* refusedStreamMcpServer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `MCP event stream ${randomUUID().slice(0, 8)}`,
          files: appFiles(server.url),
        });
        yield* evidence.json("deploy.json", deployed);
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        const called = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "remote.ping",
          kind: "query",
          input: {},
        });
        yield* evidence.json("call.json", called);
        expect(called.status, JSON.stringify(called.body)).toBe(200);
        expect(called.body).toMatchObject({ structuredContent: { reply: "pong" } });
        // The server did refuse the stream during the session; the tools were listed regardless.
        const requests = yield* server.requests;
        yield* evidence.json("upstream-requests.json", requests);
        expect(requests).toContain("GET 401");
        expect(requests).toContain("POST tools/list");
      }),
    ),
  );
});
