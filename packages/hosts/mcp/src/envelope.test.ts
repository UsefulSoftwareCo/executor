// ---------------------------------------------------------------------------
// Envelope regression tests — lock in the streamable-HTTP contract the shared
// `McpServingRoutes` must preserve, independent of any provider:
//
//   1. A method the transport doesn't serve (PUT/PATCH/…) -> 405 -32001.
//   2. An OPTIONS preflight on a provider-declared discovery path -> 204 + CORS.
//   3. A request-orchestration defect -> 500 -32603 + the McpErrorReporter fires.
//
// Built with minimal stub seams so the assertions target the envelope alone.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Layer, Ref } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import {
  authenticated,
  forbidden,
  McpAuthProvider,
  McpErrorReporter,
  McpErrorReporterNoop,
  McpServingRoutes,
  McpDiscoveryRoutes,
  McpSessionStore,
  type McpResource,
  type McpDispatchResult,
  type Principal,
} from "./index";

const DISCOVERY_PATH = "/.well-known/oauth-protected-resource" as const;

const TEST_PRINCIPAL: Principal = {
  accountId: "acct_test",
  organizationId: "org_test",
  organizationName: "Test Org",
  email: "test@example.com",
  name: "Test",
  avatarUrl: null,
  roles: ["user"],
};

/** An auth provider that authenticates everything (so dispatch is reached). */
const AuthProviderLive = Layer.succeed(McpAuthProvider)({
  discoveryRoutes: [
    {
      path: DISCOVERY_PATH,
      handler: () => Effect.succeed(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    },
  ],
  resourceMetadataUrl: (request) => `${new URL(request.url).origin}${DISCOVERY_PATH}`,
  authenticate: () => Effect.succeed(authenticated(TEST_PRINCIPAL)),
});

/** A store whose dispatch dies — induces the orchestration defect for case 3. */
const DefectStoreLive = Layer.succeed(McpSessionStore)({
  dispatch: (): Effect.Effect<McpDispatchResult> => Effect.die("induced defect"),
  dispose: () => Effect.void,
});

/** A store whose dispatch never runs — used for the 405 case (rejected first). */
const OkStoreLive = Layer.succeed(McpSessionStore)({
  dispatch: (): Effect.Effect<McpDispatchResult> =>
    Effect.succeed(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1 }), { status: 200 })),
  dispose: () => Effect.void,
});

const buildHandler = (
  store: Layer.Layer<McpSessionStore>,
  reporter: Layer.Layer<McpErrorReporter>,
  authProvider: Layer.Layer<McpAuthProvider> = AuthProviderLive,
): ((request: Request) => Promise<Response>) => {
  const Seams = Layer.mergeAll(authProvider, store, reporter);
  const RouteLive = McpServingRoutes.pipe(
    HttpRouter.provideRequest(Seams),
    Layer.provide(authProvider),
  );
  return HttpRouter.toWebHandler(RouteLive.pipe(Layer.provideMerge(HttpServer.layerServices)))
    .handler;
};

describe("McpServingRoutes envelope", () => {
  it("rejects a non-GET/POST/DELETE/OPTIONS method with 405 -32001 before dispatch", async () => {
    const handler = buildHandler(OkStoreLive, McpErrorReporterNoop);
    for (const method of ["PUT", "PATCH"] as const) {
      const response = await handler(
        new Request("https://host.test/mcp", {
          method,
          headers: { authorization: "Bearer x", "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
      );
      expect(response.status, `${method} should be 405`).toBe(405);
      const body = (await response.json()) as { error: { code: number; message: string } };
      expect(body.error.code).toBe(-32001);
      expect(body.error.message).toMatch(/method not allowed/i);
    }
  });

  it("answers an OPTIONS preflight on a discovery path with 204 + CORS", async () => {
    const handler = buildHandler(OkStoreLive, McpErrorReporterNoop);
    const response = await handler(
      new Request(`https://host.test${DISCOVERY_PATH}`, {
        method: "OPTIONS",
        headers: { origin: "https://claude.ai", "access-control-request-method": "GET" },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, DELETE, OPTIONS");
    expect(response.headers.get("access-control-allow-headers") ?? "").toContain("authorization");
  });

  it("renders 500 -32603 + CORS and fires the reporter on an orchestration defect", async () => {
    const reported = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]));
    const RecordingReporter = Layer.succeed(McpErrorReporter)({
      report: (cause: Cause.Cause<unknown>) =>
        Ref.update(reported, (acc) => [...acc, Cause.pretty(cause)]),
    });

    const handler = buildHandler(DefectStoreLive, RecordingReporter);
    const response = await handler(
      new Request("https://host.test/mcp", {
        method: "POST",
        headers: { authorization: "Bearer x", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await response.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32603);
    expect(body.error.message).toMatch(/internal server error/i);

    const captures = await Effect.runPromise(Ref.get(reported));
    expect(captures).toHaveLength(1);
    expect(captures[0]).toContain("induced defect");
  });

  it("does not dispose a session id on an auth-level Forbidden outcome", async () => {
    const disposed = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]));
    const ForbiddenAuthProviderLive = Layer.succeed(McpAuthProvider)({
      discoveryRoutes: [],
      resourceMetadataUrl: (request) => `${new URL(request.url).origin}${DISCOVERY_PATH}`,
      authenticate: () => Effect.succeed(forbidden("No organization in session", -32001)),
    });
    const RecordingStoreLive = Layer.succeed(McpSessionStore)({
      dispatch: (): Effect.Effect<McpDispatchResult> => Effect.die("dispatch should not run"),
      dispose: (sessionId) => Ref.update(disposed, (ids) => [...ids, sessionId]),
    });

    const handler = buildHandler(
      RecordingStoreLive,
      McpErrorReporterNoop,
      ForbiddenAuthProviderLive,
    );
    const response = await handler(
      new Request("https://host.test/mcp/toolkits/deploy", {
        method: "POST",
        headers: {
          authorization: "Bearer x",
          "mcp-session-id": "leaked-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );

    expect(response.status).toBe(403);
    expect(await Effect.runPromise(Ref.get(disposed))).toEqual([]);
  });
});

it("dispatches toolkit MCP routes with the parsed toolkit resource", async () => {
  const seen = await Effect.runPromise(Ref.make<McpResource | null>(null));
  const RecordingStoreLive = Layer.succeed(McpSessionStore)({
    dispatch: ({ resource }): Effect.Effect<McpDispatchResult> =>
      Ref.set(seen, resource).pipe(
        Effect.as(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1 }), { status: 200 })),
      ),
    dispose: () => Effect.void,
  });

  const handler = buildHandler(RecordingStoreLive, McpErrorReporterNoop);
  const response = await handler(
    new Request("https://host.test/mcp/toolkits/deploy", {
      method: "POST",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );

  expect(response.status).toBe(200);
  expect(await Effect.runPromise(Ref.get(seen))).toEqual({
    kind: "toolkit",
    slug: "deploy",
  });
});

describe("McpDiscoveryRoutes (discovery-only, no session store)", () => {
  // Builds with the auth seam ALONE — no McpSessionStore. This is the cloud
  // shape: the Agent bridge serves /mcp transport, the envelope only publishes
  // the provider's OAuth discovery docs. If this required McpSessionStore it
  // would not compile, so the build itself is part of the assertion.
  const discoveryHandler = (): ((request: Request) => Promise<Response>) =>
    HttpRouter.toWebHandler(
      McpDiscoveryRoutes.pipe(
        Layer.provide(AuthProviderLive),
        Layer.provideMerge(HttpServer.layerServices),
      ),
    ).handler;

  it("serves the provider discovery document on GET", async () => {
    const handler = discoveryHandler();
    const response = await handler(new Request(`https://host.test${DISCOVERY_PATH}`));
    expect(response.status).toBe(200);
    expect((await response.json()) as { ok: boolean }).toEqual({ ok: true });
  });

  it("answers an OPTIONS preflight on a discovery path with 204 + CORS", async () => {
    const handler = discoveryHandler();
    const response = await handler(
      new Request(`https://host.test${DISCOVERY_PATH}`, { method: "OPTIONS" }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("does NOT mount the /mcp transport route", async () => {
    const handler = discoveryHandler();
    const response = await handler(
      new Request("https://host.test/mcp", {
        method: "POST",
        headers: { authorization: "Bearer x", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(response.status).toBe(404);
  });
});
