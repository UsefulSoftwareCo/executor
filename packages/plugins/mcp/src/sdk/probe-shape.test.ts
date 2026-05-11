import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { serveTestHttpApp } from "@executor-js/sdk/testing";

import { probeMcpEndpointShape } from "./probe-shape";

interface CapturedProbeRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

type ProbeHandler = (request: CapturedProbeRequest) => HttpServerResponse.HttpServerResponse;

const serveProbeEndpoint = (handler: ProbeHandler) =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<readonly CapturedProbeRequest[]>([]);
    const server = yield* serveTestHttpApp((request) =>
      Effect.gen(function* () {
        const body = yield* request.text;
        const captured = {
          method: request.method,
          url: request.url ?? "/",
          headers: request.headers,
          body,
        };
        yield* Ref.update(requests, (all) => [...all, captured]);
        return handler(captured);
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(HttpServerResponse.text("probe fixture request failed", { status: 500 })),
        ),
      ),
    );

    return {
      endpoint: server.url("/probe"),
      requests: Ref.get(requests),
    } as const;
  });

const withServer = <A, E>(handler: ProbeHandler, use: (endpoint: string) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* serveProbeEndpoint(handler);
      return yield* use(server.endpoint);
    }),
  );

describe("probeMcpEndpointShape", () => {
  it.effect("classifies 2xx as unauth-OK MCP", () =>
    withServer(
      () =>
        HttpServerResponse.jsonUnsafe({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            serverInfo: { name: "t", version: "0" },
          },
        }),
      (endpoint) =>
        Effect.gen(function* () {
          const result = yield* probeMcpEndpointShape(endpoint);
          expect(result).toEqual({ kind: "mcp", requiresAuth: false });
        }),
    ),
  );

  it.effect("classifies 401 with Bearer + JSON-RPC error envelope as MCP+auth", () =>
    withServer(
      () =>
        HttpServerResponse.jsonUnsafe(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32000, message: "Unauthorized" },
          },
          {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"',
            },
          },
        ),
      (endpoint) =>
        Effect.gen(function* () {
          const result = yield* probeMcpEndpointShape(endpoint);
          expect(result).toEqual({ kind: "mcp", requiresAuth: true });
        }),
    ),
  );

  // mcp.sentry.dev/mcp/ shape: spec-compliant `resource_metadata=`
  // attribute, body is RFC 6750 OAuth-shape (`{error: "invalid_token",
  // ...}`), not JSON-RPC. The `resource_metadata=` attribute alone is
  // enough to classify as MCP — the body-shape gate is for the bare-Bearer
  // case where we have no other signal.
  it.effect("classifies 401 with resource_metadata + OAuth error body as MCP+auth", () =>
    withServer(
      () =>
        HttpServerResponse.jsonUnsafe(
          {
            error: "invalid_token",
            error_description: "Missing or invalid access token",
          },
          {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer realm="OAuth", resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp/", error="invalid_token"',
            },
          },
        ),
      (endpoint) =>
        Effect.gen(function* () {
          const result = yield* probeMcpEndpointShape(endpoint);
          expect(result).toEqual({ kind: "mcp", requiresAuth: true });
        }),
    ),
  );

  // Supabase shape: Bearer challenge has `error=`/`error_description=`
  // auth-params (RFC 6750 §3.1) but no `resource_metadata=`, and body is
  // a non-RFC-6750 `{"message":"Unauthorized"}` envelope. The `error=`
  // attribute alone is the accept signal.
  it.effect("classifies 401 with Bearer error= auth-param as MCP+auth", () =>
    withServer(
      () =>
        HttpServerResponse.jsonUnsafe(
          { message: "Unauthorized" },
          {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer error="invalid_request", error_description="No authorization header found"',
            },
          },
        ),
      (endpoint) =>
        Effect.gen(function* () {
          const result = yield* probeMcpEndpointShape(endpoint);
          expect(result).toEqual({ kind: "mcp", requiresAuth: true });
        }),
    ),
  );

  // cubic.dev/api/mcp shape: bare `Bearer` challenge, no resource_metadata.
  // The JSON-RPC error body is what tells us this is MCP rather than some
  // other OAuth/API-key protected service.
  it.effect("classifies 401 with bare Bearer + JSON-RPC error as MCP+auth", () =>
    withServer(
      () =>
        HttpServerResponse.jsonUnsafe(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32000, message: "Unauthorized: Valid API key required." },
          },
          { status: 401, headers: { "www-authenticate": "Bearer" } },
        ),
      (endpoint) =>
        Effect.gen(function* () {
          const result = yield* probeMcpEndpointShape(endpoint);
          expect(result).toEqual({ kind: "mcp", requiresAuth: true });
        }),
    ),
  );

  it.effect("rejects 401 without WWW-Authenticate as auth-required", () =>
    withServer(
      () => HttpServerResponse.text("nope", { status: 401 }),
      (endpoint) =>
        Effect.gen(function* () {
          const result = yield* probeMcpEndpointShape(endpoint);
          expect(result).toMatchObject({ kind: "not-mcp", category: "auth-required" });
        }),
    ),
  );

  it.effect("rejects 401 + Bearer with empty body as auth-required", () =>
    withServer(
      () =>
        HttpServerResponse.empty({
          status: 401,
          headers: { "www-authenticate": "Bearer" },
        }),
      (endpoint) =>
        Effect.gen(function* () {
          const result = yield* probeMcpEndpointShape(endpoint);
          expect(result).toMatchObject({ kind: "not-mcp", category: "auth-required" });
        }),
    ),
  );

  // Railway-style: OAuth-protected GraphQL endpoint that returns a Bearer
  // challenge but a non-JSON-RPC error envelope. Must NOT be classified as
  // MCP — otherwise we misclassify any OAuth-protected non-MCP service.
  it.effect("rejects 401 + Bearer with GraphQL-shape body as auth-required", () =>
    withServer(
      () =>
        HttpServerResponse.jsonUnsafe(
          { errors: [{ message: "Unauthorized" }] },
          { status: 401, headers: { "www-authenticate": "Bearer" } },
        ),
      (endpoint) =>
        Effect.gen(function* () {
          const result = yield* probeMcpEndpointShape(endpoint);
          expect(result).toMatchObject({ kind: "not-mcp", category: "auth-required" });
        }),
    ),
  );

  it.effect("falls back to GET for OAuth-protected SSE endpoints", () =>
    withServer(
      (request) => {
        if (request.method === "POST") {
          return HttpServerResponse.empty({ status: 405 });
        }
        return HttpServerResponse.jsonUnsafe(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32000, message: "Unauthorized" },
          },
          {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"',
            },
          },
        );
      },
      (endpoint) =>
        Effect.gen(function* () {
          const result = yield* probeMcpEndpointShape(endpoint);
          expect(result).toEqual({ kind: "mcp", requiresAuth: true });
        }),
    ),
  );

  it.effect("classifies unauthenticated SSE GET endpoints as MCP", () =>
    withServer(
      (request) => {
        if (request.method === "POST") {
          return HttpServerResponse.empty({ status: 405 });
        }
        return HttpServerResponse.text("event: endpoint\n\n", {
          status: 200,
          contentType: "text/event-stream",
        });
      },
      (endpoint) =>
        Effect.gen(function* () {
          const result = yield* probeMcpEndpointShape(endpoint);
          expect(result).toEqual({ kind: "mcp", requiresAuth: false });
        }),
    ),
  );

  it.effect("rejects 2xx with non-JSON-RPC JSON body as wrong-shape", () =>
    withServer(
      () => HttpServerResponse.jsonUnsafe({ ok: true, data: { id: "x" } }),
      (endpoint) =>
        Effect.gen(function* () {
          const result = yield* probeMcpEndpointShape(endpoint);
          expect(result).toMatchObject({ kind: "not-mcp", category: "wrong-shape" });
        }),
    ),
  );

  it.effect("rejects 2xx with HTML body as wrong-shape", () =>
    withServer(
      () =>
        HttpServerResponse.text("<!doctype html><html></html>", {
          contentType: "text/html",
        }),
      (endpoint) =>
        Effect.gen(function* () {
          const result = yield* probeMcpEndpointShape(endpoint);
          expect(result).toMatchObject({ kind: "not-mcp", category: "wrong-shape" });
        }),
    ),
  );

  it.effect("rejects 400 GraphQL-shape responses as wrong-shape", () =>
    withServer(
      () =>
        HttpServerResponse.jsonUnsafe(
          { errors: [{ message: "Problem processing request" }] },
          { status: 400 },
        ),
      (endpoint) =>
        Effect.gen(function* () {
          const result = yield* probeMcpEndpointShape(endpoint);
          expect(result).toMatchObject({ kind: "not-mcp", category: "wrong-shape" });
        }),
    ),
  );

  it.effect("rejects 404 as wrong-shape", () =>
    withServer(
      () => HttpServerResponse.empty({ status: 404 }),
      (endpoint) =>
        Effect.gen(function* () {
          const result = yield* probeMcpEndpointShape(endpoint);
          expect(result).toMatchObject({ kind: "not-mcp", category: "wrong-shape" });
        }),
    ),
  );

  it.effect("reports transport failure as unreachable", () =>
    Effect.gen(function* () {
      const result = yield* probeMcpEndpointShape("http://127.0.0.1:1/missing", {
        timeoutMs: 100,
      });
      expect(result.kind).toBe("unreachable");
    }),
  );
});
