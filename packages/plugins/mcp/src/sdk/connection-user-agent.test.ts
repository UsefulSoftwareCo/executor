import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import type { OAuthClientProvider } from "@modelcontextprotocol/client";

import { createMcpConnector } from "./connection";
import { makeEchoMcpServer, serveMcpServer } from "../testing";

const endpoint = "https://mcp.example/mcp";

/** Records each request's User-Agent and answers 405, so `auto` exercises
 *  both the Streamable HTTP attempt and the SSE fallback. */
const recordingClientLayer = (userAgents: Array<string | undefined>) =>
  Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      userAgents.push(request.headers["user-agent"]);
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response("unsupported", { status: 405 })),
      );
    }),
  );

const unauthorizedProvider: OAuthClientProvider = {
  get redirectUrl() {
    return "http://localhost/oauth/callback";
  },
  get clientMetadata() {
    return {
      redirect_uris: ["http://localhost/oauth/callback"],
      grant_types: ["authorization_code"] as string[],
      response_types: ["code"] as string[],
      token_endpoint_auth_method: "none" as const,
      client_name: "Executor",
    };
  },
  clientInformation: () => ({ client_id: "test-client" }),
  saveClientInformation: () => undefined,
  tokens: () => ({ access_token: "rejected-token", token_type: "Bearer" }),
  saveTokens: () => undefined,
  redirectToAuthorization: () => undefined,
  saveCodeVerifier: () => undefined,
  codeVerifier: () => "unused",
};

describe("MCP remote User-Agent", () => {
  it.effect("sends a default User-Agent on both transports through the HTTP client layer", () =>
    Effect.gen(function* () {
      const userAgents: Array<string | undefined> = [];

      yield* createMcpConnector({
        transport: "remote",
        endpoint,
        remoteTransport: "auto",
        httpClientLayer: recordingClientLayer(userAgents),
      }).pipe(Effect.flip);

      expect(userAgents.length).toBeGreaterThanOrEqual(2);
      expect(new Set(userAgents)).toEqual(new Set(["executor"]));
    }),
  );

  it.effect("keeps a configured User-Agent through the HTTP client layer", () =>
    Effect.gen(function* () {
      const userAgents: Array<string | undefined> = [];

      yield* createMcpConnector({
        transport: "remote",
        endpoint,
        remoteTransport: "auto",
        headers: { "user-agent": "custom-agent/1.0" },
        httpClientLayer: recordingClientLayer(userAgents),
      }).pipe(Effect.flip);

      expect(userAgents.length).toBeGreaterThanOrEqual(2);
      expect(new Set(userAgents)).toEqual(new Set(["custom-agent/1.0"]));
    }),
  );

  it.effect("sends a default User-Agent over Streamable HTTP with global fetch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveMcpServer(() => makeEchoMcpServer());

        const connection = yield* createMcpConnector({
          transport: "remote",
          endpoint: server.endpoint,
          remoteTransport: "streamable-http",
        });
        yield* Effect.promise(() => connection.client.listTools());
        yield* Effect.promise(() => connection.close());

        const requests = yield* server.requests;
        expect(requests.length).toBeGreaterThan(0);
        expect(new Set(requests.map((request) => request.userAgent))).toEqual(
          new Set(["executor"]),
        );
      }),
    ),
  );

  it.effect("keeps a configured User-Agent over Streamable HTTP with global fetch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveMcpServer(() => makeEchoMcpServer());

        const connection = yield* createMcpConnector({
          transport: "remote",
          endpoint: server.endpoint,
          remoteTransport: "streamable-http",
          headers: { "User-Agent": "custom-agent/1.0" },
        });
        yield* Effect.promise(() => connection.close());

        const requests = yield* server.requests;
        expect(requests.length).toBeGreaterThan(0);
        expect(new Set(requests.map((request) => request.userAgent))).toEqual(
          new Set(["custom-agent/1.0"]),
        );
      }),
    ),
  );

  it.effect("sends a default User-Agent on the SSE stream with global fetch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The test server speaks Streamable HTTP only, so the SSE dial fails;
        // the request it made is what this asserts on.
        const server = yield* serveMcpServer(() => makeEchoMcpServer());

        yield* createMcpConnector({
          transport: "remote",
          endpoint: server.endpoint,
          remoteTransport: "sse",
        }).pipe(Effect.flip);

        const requests = yield* server.requests;
        expect(requests.map((request) => request.method)).toContain("GET");
        expect(new Set(requests.map((request) => request.userAgent))).toEqual(
          new Set(["executor"]),
        );
      }),
    ),
  );

  it.effect("sends a default User-Agent on OAuth resource metadata discovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveMcpServer(() => makeEchoMcpServer(), {
          auth: {
            validateAuthorization: () => Effect.succeed(false),
            // Unreachable on purpose: discovery stops after the resource
            // metadata request this test inspects.
            authorizationServerUrls: ["http://127.0.0.1:1"],
          },
        });

        yield* createMcpConnector({
          transport: "remote",
          endpoint: server.endpoint,
          remoteTransport: "streamable-http",
          authProvider: unauthorizedProvider,
        }).pipe(Effect.flip);

        const requests = yield* server.requests;
        const discovery = requests.filter((request) =>
          request.url.startsWith("/.well-known/oauth-protected-resource"),
        );
        expect(discovery.length).toBeGreaterThan(0);
        expect(new Set(requests.map((request) => request.userAgent))).toEqual(
          new Set(["executor"]),
        );
      }),
    ),
  );
});
