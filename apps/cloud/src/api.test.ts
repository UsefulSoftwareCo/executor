import {
  HttpApi,
  HttpApiBuilder,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/unstable/httpapi";
import {
  FetchHttpClient,
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/unstable/http";
import { expect, layer } from "@effect/vitest";
import { Cause, Effect, Layer, Schema } from "effect";
import { toErrorServerResponse } from "./api/error-response";

const SourceResponse = Schema.Struct({ source: Schema.String });

// ---------------------------------------------------------------------------
// Test APIs — mirror the prod paths but with stub handlers.
// ---------------------------------------------------------------------------

const OrgGroup = HttpApiGroup.make("org").add(
  HttpApiEndpoint.get("ping", "/org/ping", { success: SourceResponse }),
);
const OrgTestApi = HttpApi.make("orgApi").add(OrgGroup);

const AuthGroup = HttpApiGroup.make("auth").add(
  HttpApiEndpoint.get("me", "/auth/me", { success: SourceResponse }),
);
const AuthTestApi = HttpApi.make("authApi").add(AuthGroup);

const ProtectedGroup = HttpApiGroup.make("protected")
  .add(HttpApiEndpoint.get("scope", "/scope", { success: SourceResponse }))
  .add(
    HttpApiEndpoint.get("sources", "/scopes/:scopeId/sources", {
      params: { scopeId: Schema.String },
      success: SourceResponse,
    }),
  )
  .add(
    HttpApiEndpoint.post("resume", "/executions/:executionId/resume", {
      params: { executionId: Schema.String },
      success: SourceResponse,
    }),
  );
const ProtectedTestApi = HttpApi.make("protectedApi").add(ProtectedGroup);

// ---------------------------------------------------------------------------
// Stub handlers
// ---------------------------------------------------------------------------

const OrgTestHandlers = HttpApiBuilder.group(OrgTestApi, "org", (handlers) =>
  handlers.handle("ping", () => Effect.succeed({ source: "org" })),
);

const AuthHandlers = HttpApiBuilder.group(AuthTestApi, "auth", (handlers) =>
  handlers.handle("me", () => Effect.succeed({ source: "auth" })),
);

const ProtectedHandlers = HttpApiBuilder.group(ProtectedTestApi, "protected", (handlers) =>
  handlers
    .handle("scope", () => Effect.succeed({ source: "protected" }))
    .handle("sources", ({ params }) => Effect.succeed({ source: params.scopeId }))
    .handle("resume", () => Effect.succeed({ source: "protected" })),
);

// ---------------------------------------------------------------------------
// Per-test mode switch — controls a router-level gate that mirrors the prod
// `ExecutionStackMiddleware`'s short-circuit branches without standing up
// the full WorkOS / executor stack.
// ---------------------------------------------------------------------------

type ProtectedMode = "ok" | "none" | "error" | "bad-status" | "defect";
const testState: { mode: ProtectedMode } = { mode: "ok" };
const resetState = () => {
  testState.mode = "ok";
};

// `Effect.suspend` so `testState.mode` is read per request — the
// middleware function itself runs once at addAll time, wrapping each
// route's handler. Without `suspend`, only the build-time mode ("ok")
// would be observed.
const TestProtectedGate = HttpRouter.middleware()((httpEffect) =>
  Effect.suspend(() => {
    if (testState.mode === "none") {
      return Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { error: "No organization in session", code: "no_organization" },
          { status: 403 },
        ),
      );
    }
    if (testState.mode === "error") {
      return Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "boom" }, { status: 500 }));
    }
    if (testState.mode === "bad-status") {
      return Effect.succeed(
        HttpServerResponse.jsonUnsafe({ source: "protected" }, { status: 400 }),
      );
    }
    if (testState.mode === "defect") {
      return Effect.succeed(toErrorServerResponse(Cause.die("secret-bearing failure detail")));
    }
    return httpEffect;
  }),
).layer;

// ---------------------------------------------------------------------------
// Wire test APIs as route layers + autumn route, mirroring prod's structure.
// ---------------------------------------------------------------------------

const RouterConfig = Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 });

const OrgTestLive = HttpApiBuilder.layer(OrgTestApi).pipe(Layer.provide(OrgTestHandlers));
const AuthTestLive = HttpApiBuilder.layer(AuthTestApi).pipe(Layer.provide(AuthHandlers));
const ProtectedTestLive = HttpApiBuilder.layer(ProtectedTestApi).pipe(
  Layer.provide(ProtectedHandlers),
  Layer.provide(TestProtectedGate),
);

const AutumnTestRoutesLive = HttpRouter.add(
  "*",
  "/autumn/*",
  Effect.succeed(HttpServerResponse.jsonUnsafe({ source: "autumn" })),
);

const TestApiLive = Layer.mergeAll(
  OrgTestLive,
  AuthTestLive,
  ProtectedTestLive,
  AutumnTestRoutesLive,
).pipe(Layer.provideMerge(RouterConfig), Layer.provideMerge(HttpServer.layerServices));

const requestHandler = HttpRouter.toWebHandler(TestApiLive, { disableLogger: true }).handler;

// ---------------------------------------------------------------------------
// Client setup — route HttpClient calls through the web handler in-process
// so the suite runs in any runtime (workerd's `NodeHttpServer.layerTest`
// crashes the isolate).
// ---------------------------------------------------------------------------

const TestApi = HttpApi.make("testApi")
  .add(OrgGroup)
  .add(AuthGroup)
  .add(
    HttpApiGroup.make("autumn").add(
      HttpApiEndpoint.get("plans", "/autumn/plans", { success: SourceResponse }),
    ),
  )
  .add(ProtectedGroup);

const TEST_BASE_URL = "http://test.local";
const fetchViaHandler: typeof globalThis.fetch = (input, init) =>
  requestHandler(input instanceof Request ? input : new Request(input, init));

const TestClientLayer = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fetchViaHandler)),
);

const getClient = () => HttpApiClient.make(TestApi, { baseUrl: TEST_BASE_URL });

layer(TestClientLayer)("handleApiRequest", (it) => {
  it.effect("routes /org/* to the org API handler", () =>
    Effect.gen(function* () {
      resetState();
      const client = yield* getClient();
      const result = yield* client.org.ping();
      expect(result).toEqual({ source: "org" });
    }),
  );

  it.effect("routes /auth/* to the auth API handler", () =>
    Effect.gen(function* () {
      resetState();
      const client = yield* getClient();
      const result = yield* client.auth.me();
      expect(result).toEqual({ source: "auth" });
    }),
  );

  it.effect("routes /autumn/* to the autumn handler", () =>
    Effect.gen(function* () {
      resetState();
      const client = yield* getClient();
      const result = yield* client.autumn.plans();
      expect(result).toEqual({ source: "autumn" });
    }),
  );

  it.effect("routes non-auth paths to protected handler", () =>
    Effect.gen(function* () {
      resetState();
      const client = yield* getClient();
      const result = yield* client.protected.scope();
      expect(result).toEqual({ source: "protected" });
    }),
  );

  it.effect("returns 403 when protected gate short-circuits with no organization", () =>
    Effect.gen(function* () {
      resetState();
      testState.mode = "none";

      const response = yield* HttpClient.get(`${TEST_BASE_URL}/scope`);
      expect(response.status).toBe(403);
      const body = yield* response.json;
      expect(body).toEqual({
        error: "No organization in session",
        code: "no_organization",
      });
    }),
  );

  it.effect("routes resume paths to protected handler", () =>
    Effect.gen(function* () {
      resetState();
      const client = yield* getClient();
      const result = yield* client.protected.resume({ params: { executionId: "exec_1" } });
      expect(result).toEqual({ source: "protected" });
    }),
  );

  it.effect("preserves protected path params", () =>
    Effect.gen(function* () {
      resetState();
      const client = yield* getClient();
      const result = yield* client.protected.sources({ params: { scopeId: "org_1" } });
      expect(result).toEqual({ source: "org_1" });
    }),
  );

  it.effect("returns protected response status as-is", () =>
    Effect.gen(function* () {
      resetState();
      testState.mode = "bad-status";

      const response = yield* HttpClient.post(`${TEST_BASE_URL}/executions/exec_1/resume`);
      expect(response.status).toBe(400);
    }),
  );

  it.effect("returns 500 JSON when protected gate returns 500", () =>
    Effect.gen(function* () {
      resetState();
      testState.mode = "error";

      const response = yield* HttpClient.get(`${TEST_BASE_URL}/scope`);
      expect(response.status).toBe(500);
      const body = yield* response.json;
      expect(body).toEqual({ error: "boom" });
    }),
  );

  it.effect("maps protected defects to the generic API error body", () =>
    Effect.gen(function* () {
      resetState();
      testState.mode = "defect";

      const response = yield* HttpClient.get(`${TEST_BASE_URL}/scope`);
      expect(response.status).toBe(500);
      const body = yield* response.json;
      expect(body).toEqual({
        error: "Internal server error",
        code: "internal_server_error",
      });
    }),
  );
});
