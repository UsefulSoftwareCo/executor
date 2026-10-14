/**
 * A public documentation-search MCP server on loopback, shaped like Cloudflare's docs server
 * (https://docs.mcp.cloudflare.com/mcp): no account, Streamable HTTP with a session the server
 * issues on `initialize`, every answer on a short event stream, and one read-only search tool
 * that returns structured results. Only the public JSON-RPC and Streamable HTTP wire contract is
 * used. `queries` lists each search the server received.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Ref, Schema, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

const Message = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(
    Schema.Struct({
      protocolVersion: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
      arguments: Schema.optional(Schema.Struct({ query: Schema.optional(Schema.String) })),
    }),
  ),
});

/** The fixture's search tool. */
export const docsSearchTool = "search_documentation";
/** Where the fixture's search results point. */
export const docsOrigin = "https://docs.fixture.test";

const event = (message: object) =>
  new TextEncoder().encode(
    `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", ...message })}\n\n`,
  );

/** Return the server's MCP URL and the searches it received; the scope owns its listener. */
export const docsMcpFixture = Effect.gen(function* () {
  const sessions = new Set<string>();
  const queries = yield* Ref.make<ReadonlyArray<string>>([]);
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const message = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Message)));
    const stream = (result: object, headers: Record<string, string> = {}) =>
      HttpServerResponse.stream(Stream.make(event({ id: message.id, result })), {
        contentType: "text/event-stream",
        headers,
      });
    if (message.method === "initialize") {
      const session = randomUUID();
      sessions.add(session);
      return stream(
        {
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture-docs", version: "1" },
        },
        { "mcp-session-id": session },
      );
    }
    // Every later message names the session `initialize` issued, as Streamable HTTP requires.
    const session = request.headers["mcp-session-id"];
    if (session === undefined) return HttpServerResponse.text("Missing session", { status: 400 });
    if (!sessions.has(session)) return HttpServerResponse.text("Unknown session", { status: 404 });
    if (message.id === undefined) return HttpServerResponse.empty({ status: 202 });
    switch (message.method) {
      case "tools/list":
        return stream({
          tools: [
            {
              name: docsSearchTool,
              description: "Search the documentation and return matching pages",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
              outputSchema: {
                type: "object",
                properties: {
                  results: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { url: { type: "string" }, title: { type: "string" } },
                      required: ["url", "title"],
                    },
                  },
                },
                required: ["results"],
              },
              annotations: { readOnlyHint: true },
            },
          ],
        });
      case "tools/call": {
        const query = message.params?.arguments?.query ?? "";
        if (message.params?.name !== docsSearchTool || query === "")
          return stream({ isError: true, content: [{ type: "text", text: "Unknown search" }] });
        yield* Ref.update(queries, (all) => [...all, query]);
        const slug = query.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
        const results = [
          { url: `${docsOrigin}/${slug}/`, title: `${query} · Overview` },
          { url: `${docsOrigin}/${slug}/get-started/`, title: `Get started with ${query}` },
        ];
        return stream({
          content: [{ type: "text", text: JSON.stringify({ results }) }],
          structuredContent: { results },
        });
      }
      default:
        return stream({});
    }
  }).pipe(Effect.orDie);
  const services = yield* Layer.build(
    HttpRouter.serve(
      Layer.mergeAll(
        HttpRouter.add("POST", "/mcp", handler),
        // No standalone stream: every answer rides on its request's own.
        HttpRouter.add("GET", "/mcp", Effect.succeed(HttpServerResponse.empty({ status: 405 }))),
        HttpRouter.add("DELETE", "/mcp", Effect.succeed(HttpServerResponse.empty({ status: 204 }))),
      ),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address))
    return yield* Effect.die("The docs MCP fixture requires a TCP listener");
  return {
    url: `http://127.0.0.1:${server.address.port}/mcp`,
    queries: Ref.get(queries),
  };
});
