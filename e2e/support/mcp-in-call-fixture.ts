/**
 * A synthetic upstream MCP server whose tools act inside their own call, using only the public
 * JSON-RPC and Streamable HTTP wire contract: `confirm` asks its client a question before answering,
 * and `refresh` announces that its tool list changed. Both messages travel on the call's own event
 * stream, so the call is still open when the client handles them.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Layer, Schema, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

const Message = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(
    Schema.Struct({
      protocolVersion: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
    }),
  ),
  result: Schema.optional(Schema.Struct({ action: Schema.String })),
});

const event = (message: object) =>
  new TextEncoder().encode(
    `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", ...message })}\n\n`,
  );

/** Return the server's MCP URL; its listener is owned by the current test scope. */
export const mcpInCallFixture = Effect.gen(function* () {
  // Questions sent on a call's stream, by request ID, until the client's answer arrives.
  const asked = new Map<string, Deferred.Deferred<string>>();
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const message = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Message)));
    if (message.method === undefined) {
      // The client's answer to a question.
      const question = typeof message.id === "string" ? asked.get(message.id) : undefined;
      if (question !== undefined && message.result !== undefined)
        yield* Deferred.succeed(question, message.result.action);
      return HttpServerResponse.empty({ status: 202 });
    }
    if (message.id === undefined) return HttpServerResponse.empty({ status: 202 });
    const answer = (result: object) =>
      HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        return answer({
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "synthetic-in-call", version: "1" },
        });
      case "tools/list":
        return answer({
          tools: [
            {
              name: "confirm",
              description: "Ask the client to confirm, then answer",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            },
            {
              name: "refresh",
              description: "Announce a changed tool list, then answer",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            },
          ],
        });
      case "tools/call": {
        if (message.params?.name === "refresh")
          return HttpServerResponse.stream(
            Stream.make(
              event({ method: "notifications/tools/list_changed" }),
              event({ id: message.id, result: { content: [{ type: "text", text: "refreshed" }] } }),
            ),
            { contentType: "text/event-stream" },
          );
        const id = `ask-${randomUUID()}`;
        const question = yield* Deferred.make<string>();
        asked.set(id, question);
        return HttpServerResponse.stream(
          Stream.make(
            event({
              id,
              method: "elicitation/create",
              params: { message: "Confirm?", requestedSchema: { type: "object", properties: {} } },
            }),
          ).pipe(
            Stream.concat(
              Stream.fromEffect(
                Deferred.await(question).pipe(
                  Effect.map((action) =>
                    event({
                      id: message.id,
                      result: { content: [{ type: "text", text: action }] },
                    }),
                  ),
                ),
              ),
            ),
          ),
          { contentType: "text/event-stream" },
        );
      }
      default:
        return answer({});
    }
  }).pipe(Effect.orDie);
  const services = yield* Layer.build(
    HttpRouter.serve(
      Layer.mergeAll(
        HttpRouter.add("POST", "/mcp", handler),
        // No standalone stream: every message rides on the call's own.
        HttpRouter.add("GET", "/mcp", Effect.succeed(HttpServerResponse.empty({ status: 405 }))),
        HttpRouter.add("DELETE", "/mcp", Effect.succeed(HttpServerResponse.empty({ status: 204 }))),
      ),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address))
    return yield* Effect.die("The MCP fixture requires a TCP listener");
  return `http://127.0.0.1:${server.address.port}/mcp`;
});
