// Shared HTTP test harness for node-pool integration tests.
//
// Stands up the real ProtectedCloudApi against a real DbService and
// every real plugin (openapi / mcp / graphql / workos-vault), with
// two test-only swaps:
//
//   - `OrgAuthLive` is replaced with `FakeOrgAuthLive`, which reads
//     the org handle from the URL `/api/:org/...` prefix instead of
//     the WorkOS cookie.
//   - `workos-vault` is configured with an in-memory `WorkOSVaultClient`
//     so secret writes never reach WorkOS's real API.
//
// Tests get a `fetchForOrg(orgId)` they can hand to `FetchHttpClient`
// and then call `HttpApiClient.make(ProtectedCloudApi)` against it.
// Each test picks its own org id (usually a random UUID) so rows don't
// collide across tests. The harness seeds an organizations row whose
// `handle` equals the org id so `resolveOrgContext(orgId)` succeeds.

import { Effect, Layer } from "effect";
import { HttpApiBuilder, HttpApiClient, HttpApiSwagger } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http";

import {
  ExecutionEngineService,
  ExecutorService,
  providePluginExtensions,
  type PluginExtensionServices,
} from "@executor-js/api/server";
import { createExecutionEngine } from "@executor-js/execution";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { Scope, ScopeId, collectSchemas, createExecutor } from "@executor-js/sdk";
import { makePostgresAdapter, makePostgresBlobStore } from "@executor-js/storage-postgres";
import { makeTestWorkOSVaultClient } from "@executor-js/plugin-workos-vault/testing";

import executorConfig from "../../../executor.config";
import { AuthContext } from "../../auth/middleware";
import {
  ProtectedCloudApi,
  ProtectedCloudApiHandlers,
  RouterConfig,
} from "../../api/protected-layers";
import { DbService } from "../db";
import { organizations } from "../schema";

export const TEST_BASE_URL = "http://test.local";
/**
 * Optional header for tests that need to act as a specific user. The org
 * id always comes from the URL prefix; only the user is opt-in.
 */
export const TEST_USER_HEADER = "x-test-user-id";

// Mirrors apps/cloud/src/services/executor.ts#createScopedExecutor — the
// per-user scope id bakes in the org so the same user id in a different
// org gets a distinct scope row.
const userOrgScopeId = (userId: string, orgId: string) => `user-org:${userId}:${orgId}`;

// `asOrg(orgId, …)` callers don't care which specific user they are, only
// that the executor has a valid user-org scope. We give each org a stable
// default user so list/get operations at the org scope remain deterministic
// across calls within a single test.
const defaultUserFor = (orgId: string) => `default_user_${orgId}`;

// ---------------------------------------------------------------------------
// Executor factory — mirrors apps/cloud/services/executor#createScopedExecutor
// but with an in-memory test vault client (see
// `@executor-js/plugin-workos-vault/testing`).
// ---------------------------------------------------------------------------

const fakeVault = makeTestWorkOSVaultClient();
const testPlugins = executorConfig.plugins({ workosVaultClient: fakeVault });

const createTestScopedExecutor = (userId: string, orgId: string, orgName: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const plugins = testPlugins;
    const schema = collectSchemas(plugins);
    const adapter = makePostgresAdapter({ db, schema });
    const blobs = makePostgresBlobStore({ db });
    const orgScope = new Scope({
      id: ScopeId.make(orgId),
      name: orgName,
      createdAt: new Date(),
    });
    const userOrgScope = new Scope({
      id: ScopeId.make(userOrgScopeId(userId, orgId)),
      name: `Personal · ${orgName}`,
      createdAt: new Date(),
    });
    return yield* createExecutor({
      scopes: [userOrgScope, orgScope],
      adapter,
      blobs,
      plugins,
      onElicitation: "accept-all",
    });
  });

// Seed a test organization row whose handle equals the supplied id so the
// production middleware resolution path (`resolveOrgContext(handle)`) works
// against the test db. Uses `onConflictDoNothing` so repeated `asOrg(orgId,
// …)` calls within a test don't fight each other. Lives inside the request
// pipeline (so DbService is already provided) instead of at factory time
// — bringing up its own DbService.Live in a Node test process leaks a
// postgres.js socket that ECONNRESETs across test files.
const seedTestOrg = (orgId: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbService;
    yield* Effect.promise(() =>
      db
        .insert(organizations)
        .values({ id: orgId, handle: orgId, name: `Org ${orgId}` })
        .onConflictDoNothing(),
    );
  });

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

// Pull the URL `:org` segment from a request path. The protected API mounts
// under `/api/:org/...`. Returning `null` for a malformed prefix forces the
// downstream handler to surface a typed error rather than panicking.
const orgHandleFromPath = (pathname: string): string | null => {
  const parts = pathname.split("/").filter((part) => part.length > 0);
  if (parts.length < 2 || parts[0] !== "api") return null;
  return parts[1] ?? null;
};

// Test version of the production `ExecutionStackMiddleware` — reads the
// org handle from the URL `/api/:org/...` prefix (matching production),
// builds a test-scoped executor against the live postgres test db with a
// fake WorkOS vault, and provides `AuthContext` + the executor services
// to the handler. The optional `x-test-user-id` header overrides the
// default per-org user.
const TestExecutionStackMiddleware = HttpRouter.middleware<{
  provides:
    | AuthContext
    | ExecutorService
    | ExecutionEngineService
    | PluginExtensionServices<typeof testPlugins>;
}>()(
  // Layer-time setup — captures `DbService` so the per-request function
  // only depends on `HttpRouter`-Provided context. See `api/protected.ts`
  // for the same pattern.
  Effect.gen(function* () {
    const context = yield* Effect.context<DbService>();
    const provideExecutorExtensions = providePluginExtensions(testPlugins);
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const webRequest = yield* HttpServerRequest.toWeb(request);
        const url = new URL(webRequest.url);
        const orgId = orgHandleFromPath(url.pathname);
        if (!orgId) {
          // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: test HTTP harness has no request context without /api/:org prefix
          return yield* Effect.die(
            // oxlint-disable-next-line executor/no-error-constructor -- boundary: test HTTP harness invariant on missing prefix
            new Error(`missing /api/:org prefix in ${url.pathname}`),
          );
        }
        // Lazily seed the org row so production-mode `resolveOrgContext` (used
        // anywhere that takes the URL handle as truth) finds it. The test
        // harness can't pre-seed at factory time without leaking sockets.
        yield* seedTestOrg(orgId);
        const userHeader = request.headers[TEST_USER_HEADER];
        const userId =
          typeof userHeader === "string" && userHeader.length > 0
            ? userHeader
            : defaultUserFor(orgId);
        const orgName = `Org ${orgId}`;
        const executor = yield* createTestScopedExecutor(userId, orgId, orgName);
        const engine = createExecutionEngine({
          executor,
          codeExecutor: makeQuickJsExecutor(),
        });
        return yield* httpEffect.pipe(
          Effect.provideService(
            AuthContext,
            AuthContext.of({
              accountId: userId,
              organizationId: orgId,
              email: "test@example.com",
              name: "Test User",
              avatarUrl: null,
            }),
          ),
          Effect.provideService(ExecutorService, executor),
          Effect.provideService(ExecutionEngineService, engine),
          provideExecutorExtensions(executor),
        );
      }).pipe(Effect.provideContext(context));
  }),
).layer;

// Mirror the production setup — the protected API mounts under `/api/:org`
// via a prefixed router view. The outer `HttpRouter` from
// `HttpServer.layerServices` is the underlying state; the prefix wrapper
// rewrites added paths only.
const PrefixedRouterLayer = Layer.effect(HttpRouter.HttpRouter)(
  Effect.map(HttpRouter.HttpRouter.asEffect(), (router) => router.prefixed("/api/:org")),
);

const TestApiLive = HttpApiBuilder.layer(ProtectedCloudApi).pipe(
  Layer.provide(ProtectedCloudApiHandlers),
  Layer.provide(TestExecutionStackMiddleware),
  Layer.provide(PrefixedRouterLayer),
  Layer.provideMerge(HttpApiSwagger.layer(ProtectedCloudApi, { path: "/docs" })),
  Layer.provideMerge(RouterConfig),
  Layer.provideMerge(DbService.Live),
  Layer.provideMerge(HttpServer.layerServices),
);

const handler = HttpRouter.toWebHandler(TestApiLive, { disableLogger: true }).handler;

// Rewrite outgoing request URLs to `/api/${orgId}${path}` so the prefixed
// router matches. Tests construct `HttpApiClient.make(...)` against
// `TEST_BASE_URL` and call endpoint methods that build paths like
// `/scopes/.../sources` — we splice the org segment in front before the
// request reaches the in-process handler.
const rewriteRequestForOrg = async (
  base: Request,
  orgId: string,
  extraHeaders: Record<string, string> = {},
): Promise<Request> => {
  const url = new URL(base.url);
  if (!url.pathname.startsWith(`/api/${orgId}/`) && url.pathname !== `/api/${orgId}`) {
    url.pathname = `/api/${orgId}${url.pathname.startsWith("/") ? "" : "/"}${url.pathname}`;
  }
  // Buffer the body — Node's `RequestInit` rejects stream bodies without
  // `duplex: "half"`, and forwarding a Request through `new Request(url, {...})`
  // is fragile across runtimes. ArrayBuffer survives the round-trip cleanly.
  const body =
    base.method === "GET" || base.method === "HEAD" ? undefined : await base.arrayBuffer();
  return new Request(url.toString(), {
    method: base.method,
    headers: { ...Object.fromEntries(base.headers), ...extraHeaders },
    body,
  });
};

export const fetchForOrg = (orgId: string): typeof globalThis.fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const base = input instanceof Request ? input : new Request(input, init);
    const req = await rewriteRequestForOrg(base, orgId);
    return handler(req);
  }) as typeof globalThis.fetch;

export const fetchForUser = (userId: string, orgId: string): typeof globalThis.fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const base = input instanceof Request ? input : new Request(input, init);
    const req = await rewriteRequestForOrg(base, orgId, { [TEST_USER_HEADER]: userId });
    return handler(req);
  }) as typeof globalThis.fetch;

export const clientLayerForOrg = (orgId: string) =>
  FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fetchForOrg(orgId))),
  );

export const clientLayerForUser = (userId: string, orgId: string) =>
  FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fetchForUser(userId, orgId))),
  );

// Constructs an HttpApiClient bound to the given org, hands it to `body`,
// and provides the org-scoped fetch layer in one step. Keeps per-test
// Effect blocks focused on the actual assertions.
type ApiShape = HttpApiClient.ForApi<typeof ProtectedCloudApi>;

export const asOrg = <A, E>(
  orgId: string,
  body: (client: ApiShape) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(ProtectedCloudApi, { baseUrl: TEST_BASE_URL });
    return yield* body(client);
  }).pipe(Effect.provide(clientLayerForOrg(orgId))) as Effect.Effect<A, E>;

// Same as `asOrg` but also threads a specific user id through the fake
// OrgAuth, so the built executor's user-org scope id is
// `user-org:${userId}:${orgId}`. Use this for tests that care about
// per-user isolation inside the same org.
export const asUser = <A, E>(
  userId: string,
  orgId: string,
  body: (client: ApiShape) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(ProtectedCloudApi, { baseUrl: TEST_BASE_URL });
    return yield* body(client);
  }).pipe(Effect.provide(clientLayerForUser(userId, orgId))) as Effect.Effect<A, E>;

// Exposed so tests can build the same user-org scope id the harness uses
// when writing at a specific user's scope.
export const testUserOrgScopeId = (userId: string, orgId: string) => userOrgScopeId(userId, orgId);

// Re-exports so call sites don't need a second import.
export { ProtectedCloudApi };
