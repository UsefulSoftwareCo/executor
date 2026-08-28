import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { createMcpConnector } from "./connection";

const endpoint = "https://internal.example/mcp";

describe("MCP remote transport failures", () => {
  it.effect("surfaces TLS verification failures without retrying SSE", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const httpClientLayer = Layer.succeed(HttpClient.HttpClient)(
        HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
          requests.push(request.url);
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: {
                  code: "SELF_SIGNED_CERT_IN_CHAIN",
                  message: "do-not-leak: internal certificate detail",
                },
              }),
            }),
          );
        }),
      );

      const failure = yield* createMcpConnector({
        transport: "remote",
        endpoint,
        remoteTransport: "auto",
        httpClientLayer,
      }).pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "McpConnectionError",
        transport: "streamable-http",
        failureKind: "tls",
        message:
          "MCP HTTPS connection failed: TLS certificate verification failed. Check the server certificate and Executor's CA trust configuration.",
      });
      expect(failure.message).not.toContain("do-not-leak");
      expect(requests).toEqual([endpoint]);
    }),
  );

  it.effect("reports both attempts when a protocol mismatch falls back to SSE", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const httpClientLayer = Layer.succeed(HttpClient.HttpClient)(
        HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
          requests.push(`${request.method} ${request.url}`);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("unsupported MCP transport", { status: 405 }),
            ),
          );
        }),
      );

      const failure = yield* createMcpConnector({
        transport: "remote",
        endpoint,
        remoteTransport: "auto",
        httpClientLayer,
      }).pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "McpConnectionError",
        transport: "auto",
        failureKind: "protocol",
        message: "MCP auto transport failed. Streamable HTTP: HTTP 405. SSE fallback: HTTP 405.",
      });
      expect(requests.length).toBeGreaterThanOrEqual(2);
    }),
  );
});
