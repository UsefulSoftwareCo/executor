import { describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Predicate, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { createMcpConnector } from "./connection";

const JsonRpcId = Schema.Union([Schema.String, Schema.Number, Schema.Null]);
const JsonRpcRequest = Schema.Struct({
  id: Schema.optional(JsonRpcId),
  method: Schema.String,
});
type JsonRpcRequest = typeof JsonRpcRequest.Type;

const decodeJsonRpcRequest = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRpcRequest));

const initializeResponse = (request: HttpClientRequest.HttpClientRequest): Response => {
  const body = Predicate.isTagged(request.body, "Uint8Array")
    ? new TextDecoder().decode(request.body.body)
    : "";
  const rpc = Option.getOrElse(decodeJsonRpcRequest(body), () => ({
    id: undefined,
    method: "",
  }));
  if (rpc.method !== "initialize") return new Response(null, { status: 202 });
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        serverInfo: { name: "connection-fixture", version: "1.0.0" },
      },
    }),
    {
      headers: {
        "content-type": "application/json",
        "mcp-session-id": "connection-fixture-session",
      },
    },
  );
};

describe("MCP HTTP connection cleanup", () => {
  it.effect("aborts an open GET SSE response stream when the connection closes", () =>
    Effect.gen(function* () {
      let resolveGetStarted!: () => void;
      const getStarted = new Promise<void>((resolve) => {
        resolveGetStarted = resolve;
      });
      let resolveCancelled!: () => void;
      const cancelled = new Promise<void>((resolve) => {
        resolveCancelled = resolve;
      });
      const sseBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": priming\n\n"));
        },
        cancel() {
          resolveCancelled();
        },
      });
      const httpClientLayer = Layer.succeed(HttpClient.HttpClient)(
        HttpClient.make((request) =>
          Effect.sync(() => {
            if (request.method === "POST") {
              return HttpClientResponse.fromWeb(request, initializeResponse(request));
            }
            if (request.method === "GET") {
              resolveGetStarted();
              return HttpClientResponse.fromWeb(
                request,
                new Response(sseBody, {
                  headers: { "content-type": "text/event-stream" },
                }),
              );
            }
            return HttpClientResponse.fromWeb(request, new Response(null, { status: 405 }));
          }),
        ),
      );
      const connection = yield* createMcpConnector({
        transport: "remote",
        endpoint: "https://connection-fixture.example/mcp",
        remoteTransport: "streamable-http",
        httpClientLayer,
      });

      yield* Effect.promise(() => getStarted);
      yield* Effect.promise(() => connection.close());
      yield* Effect.promise(() => cancelled);
    }),
  );
});
