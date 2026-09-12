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
import { Cause, Effect, Layer, Ref, Schema } from "effect";
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
  orgWriteAccessForPrincipal,
  Principal as PrincipalSchema,
  preInitializeMethodNotFound,
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
  orgRoleModel: "none",
};

it("allows workspace writes only when a role-less host explicitly declares no model", () => {
  expect(orgWriteAccessForPrincipal(TEST_PRINCIPAL)).toBe("allowed");
  expect(
    orgWriteAccessForPrincipal({
      ...TEST_PRINCIPAL,
      orgRoleModel: "organization",
    }),
  ).toBe("denied");
});

it.effect("rejects a role on the no-role principal arm", () =>
  Schema.decodeUnknownEffect(PrincipalSchema)({
    ...TEST_PRINCIPAL,
    orgRole: "member",
  }).pipe(Effect.flip, Effect.asVoid),
);

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
  it("rejects HEAD with a JSON-RPC 405 before dispatch", async () => {
    const handler = buildHandler(OkStoreLive, McpErrorReporterNoop);
    const response = await handler(new Request("https://host.test/mcp", { method: "HEAD" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

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

// ---------------------------------------------------------------------------
// The pre-initialize dispatch guard. Session-less, only `initialize` is servable,
// and the transport's answer for everything else is a connection-killing HTTP
// 400. These lock in the -32601-on-200 replacement and, just as importantly,
// everything it must NOT intercept.
// ---------------------------------------------------------------------------

/** The headers a streamable-HTTP client must send on a POST; less is a 406/415. */
const MCP_POST_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
} as const;

const postBody = (body: unknown, headers: Record<string, string> = MCP_POST_HEADERS): Request =>
  new Request("https://host.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

const guard = (request: Request): Promise<Response | null> =>
  Effect.runPromise(preInitializeMethodNotFound(request));

describe("preInitializeMethodNotFound", () => {
  it("answers an unknown pre-init method with -32601 on a 200, echoing the id", async () => {
    const response = await guard(
      postBody({ jsonrpc: "2.0", id: 7, method: "server/discover", params: {} }),
    );
    expect(response).not.toBeNull();
    // 200, not 400: a per-request error the client can survive, which is the
    // entire point — a 400 makes clients tear the transport down.
    expect(response!.status).toBe(200);
    expect(response!.headers.get("content-type")).toContain("application/json");
    expect(await response!.json()).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32601, message: "Method not found" },
    });
  });

  it("generalizes past server/discover to any unknown method, including a string id", async () => {
    const response = await guard(
      postBody({ jsonrpc: "2.0", id: "abc", method: "some/futureProbe" }),
    );
    expect(await response!.json()).toEqual({
      jsonrpc: "2.0",
      id: "abc",
      error: { code: -32601, message: "Method not found" },
    });
  });

  it("lets initialize through to the transport", async () => {
    expect(
      await guard(postBody({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })),
    ).toBeNull();
  });

  it("lets a notification through — there is no id to answer", async () => {
    expect(
      await guard(postBody({ jsonrpc: "2.0", method: "notifications/initialized" })),
    ).toBeNull();
  });

  it("lets non-POST, non-JSON, and non-JSON-RPC bodies through", async () => {
    expect(await guard(new Request("https://host.test/mcp"))).toBeNull();
    expect(
      await guard(
        new Request("https://host.test/mcp", {
          method: "POST",
          headers: MCP_POST_HEADERS,
          body: "not json",
        }),
      ),
    ).toBeNull();
    expect(await guard(postBody({ id: 1, method: "tools/list" }))).toBeNull();
    expect(await guard(postBody([]))).toBeNull();
  });

  // The guard replaces ONE transport answer (-32000 on a 400) and must not
  // shadow the others. A structurally invalid JSON-RPC request is the
  // transport's 400 parse error to give, not ours to call "method not found".
  it("lets a structurally invalid JSON-RPC request through to the transport", async () => {
    // A fractional id is not a request id (the SDK's RequestIdSchema is
    // string | integer), so the transport rejects the whole message.
    expect(await guard(postBody({ jsonrpc: "2.0", id: 1.5, method: "tools/list" }))).toBeNull();
    // `params` must be an object when present.
    expect(
      await guard(postBody({ jsonrpc: "2.0", id: 1, method: "tools/list", params: 5 })),
    ).toBeNull();
    // The request schema is strict: an unknown top-level field is invalid.
    expect(
      await guard(postBody({ jsonrpc: "2.0", id: 1, method: "tools/list", extra: true })),
    ).toBeNull();
    // A wrong protocol version, and a batch, which the transport unpacks itself.
    expect(await guard(postBody({ jsonrpc: "1.0", id: 1, method: "tools/list" }))).toBeNull();
    expect(await guard(postBody([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]))).toBeNull();
  });

  // Answering 200 here would bypass the transport's content negotiation, which
  // runs before it ever looks at the body.
  it("lets a request that fails the transport's content negotiation through", async () => {
    const valid = { jsonrpc: "2.0", id: 1, method: "server/discover" };
    // Content-Type is not application/json, or is absent -> the 415.
    expect(
      await guard(
        postBody(valid, { "content-type": "text/plain", accept: MCP_POST_HEADERS.accept }),
      ),
    ).toBeNull();
    expect(await guard(postBody(valid, { accept: MCP_POST_HEADERS.accept }))).toBeNull();
    // Accept misses one of the two required types, or is absent -> the 406.
    expect(
      await guard(postBody(valid, { ...MCP_POST_HEADERS, accept: "application/json" })),
    ).toBeNull();
    expect(
      await guard(postBody(valid, { ...MCP_POST_HEADERS, accept: "text/event-stream" })),
    ).toBeNull();
    expect(await guard(postBody(valid, { "content-type": "application/json" }))).toBeNull();
  });

  it("still fires when the negotiated headers carry parameters", async () => {
    const response = await guard(
      postBody(
        { jsonrpc: "2.0", id: 3, method: "server/discover" },
        {
          "content-type": "application/json; charset=utf-8",
          accept: "application/json;q=0.9, text/event-stream;q=1.0",
        },
      ),
    );
    expect(response?.status).toBe(200);
  });

  it("leaves the caller's body readable for the transport", async () => {
    const request = postBody({ jsonrpc: "2.0", id: 1, method: "server/discover" });
    await guard(request);
    expect(await request.json()).toEqual({ jsonrpc: "2.0", id: 1, method: "server/discover" });
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
