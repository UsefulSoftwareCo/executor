// Production wiring for the protected API. Lives outside `protected-layers.ts`
// because `makeExecutionStack` imports `cloudflare:workers`, which the test
// harness can't load in the workerd test runtime.

import { HttpApiSwagger } from "effect/unstable/httpapi";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { Effect, Layer } from "effect";

import {
  ExecutionEngineService,
  ExecutorService,
  providePluginExtensions,
  type PluginExtensionServices,
} from "@executor-js/api/server";

import { cloudPlugins, type CloudPlugins } from "./cloud-plugins";
import { AuthContext } from "../auth/middleware";
import { authorizeOrganization } from "../auth/authorize-organization";
import { UserStoreService } from "../auth/context";
import { WorkOSAuth } from "../auth/workos";
import { AutumnService } from "../services/autumn";
import { DbService } from "../services/db";
import { makeExecutionStack } from "../services/execution-stack";
import { makeUserStore } from "../services/user-store";
import { HttpResponseError } from "./error-response";
import { RequestScopedServicesLive } from "./layers";
import { ProtectedCloudApi, ProtectedCloudApiLive, RouterConfig } from "./protected-layers";
import { requestScopedMiddleware } from "./request-scoped";

// Pull the URL `:org` segment from a request path. The protected API mounts
// under `/api/:org/...` — anything else is a programming error and surfaces as
// a typed `no_organization` response so the framework's error pipeline can
// render it.
const orgHandleFromPath = (pathname: string): string | null => {
  const parts = pathname.split("/").filter((part) => part.length > 0);
  if (parts.length < 2 || parts[0] !== "api") return null;
  return parts[1] ?? null;
};

// Pre-compute the per-plugin `Effect.provideService(extensionService,
// executor[id])` chain. The plugin spec carries the Service tag so
// this file doesn't import each plugin's `*/api` directly.
const provideExecutorExtensions = providePluginExtensions(cloudPlugins);

// One `HttpRouter` middleware that:
//   1. authenticates the WorkOS sealed session,
//   2. verifies live org membership (closes the JWT-cache gap — see
//      `auth/authorize-organization.ts`),
//   3. resolves the org name,
//   4. builds the per-request executor + engine,
//   5. provides `AuthContext` + the execution-stack services to the handler.
//
// Replaces both the old outer `Effect.gen` in this file (which did its own
// WorkOS lookup) and the per-route `OrgAuth` HttpApiMiddleware (which did
// a second one).
//
// Errors are NOT caught here: failures propagate as typed errors and are
// rendered to a JSON response by the framework's `Respondable` pipeline
// (see `HttpResponseError` in `./error-response.ts`). Letting `unhandled`
// pass through is what satisfies `HttpRouter.middleware`'s brand check
// without any type casts.
//
// `DbService` and `UserStoreService` are pulled from per-request context
// — `RequestScopedServicesMiddleware` (combined below) provides them
// fresh per request so the postgres.js socket lives in the request
// fiber's scope, not the worker's boot scope.
const ExecutionStackMiddleware = HttpRouter.middleware<{
  // The plugin extension Services this middleware satisfies are derived
  // from `typeof cloudPlugins` — no per-plugin `*ExtensionService`
  // imports at the host. Runtime binding mirrors the type:
  // `providePluginExtensions(cloudPlugins)(executor)` below.
  provides:
    | AuthContext
    | ExecutorService
    | ExecutionEngineService
    | PluginExtensionServices<CloudPlugins>;
}>()(
  Effect.gen(function* () {
    const longLived = yield* Effect.context<WorkOSAuth | AutumnService>();
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const webRequest = yield* HttpServerRequest.toWeb(request);
        const workos = yield* WorkOSAuth;
        const session = yield* workos.authenticateRequest(webRequest);
        if (!session) {
          return yield* new HttpResponseError({
            status: 401,
            code: "unauthorized",
            message: "Unauthorized",
          });
        }
        // The URL is the source of truth for active org. Pull the handle
        // off the request path, resolve it to an org row, and verify
        // membership against WorkOS — independent of `session.organizationId`.
        const url = new URL(webRequest.url);
        const handle = orgHandleFromPath(url.pathname);
        if (!handle) {
          return yield* new HttpResponseError({
            status: 404,
            code: "no_organization",
            message: "Missing organization in URL",
          });
        }
        const { db } = yield* DbService;
        const resolved = yield* Effect.promise(() =>
          makeUserStore(db).getOrganizationByHandle(handle),
        );
        if (!resolved) {
          return yield* new HttpResponseError({
            status: 404,
            code: "no_organization",
            message: `Organization "${handle}" not found`,
          });
        }
        const org = yield* authorizeOrganization(session.userId, resolved.id);
        if (!org) {
          return yield* new HttpResponseError({
            status: 403,
            code: "no_organization",
            message: "Not a member of this organization",
          });
        }
        const auth = AuthContext.of({
          accountId: session.userId,
          organizationId: org.id,
          email: session.email,
          name: `${session.firstName ?? ""} ${session.lastName ?? ""}`.trim() || null,
          avatarUrl: session.avatarUrl ?? null,
        });
        const { executor, engine } = yield* makeExecutionStack(auth.accountId, org.id, org.name);
        return yield* httpEffect.pipe(
          Effect.provideService(AuthContext, auth),
          Effect.provideService(ExecutorService, executor),
          Effect.provideService(ExecutionEngineService, engine),
          provideExecutorExtensions(executor),
        );
      }).pipe(Effect.provideContext(longLived));
  }),
);

// Layer that swaps the boot router with a `:org`-prefixed view, so every
// route registered by `ProtectedCloudApiLive` mounts under `/api/:org/*`.
// `HttpRouter.prefixed` returns a wrapper that delegates to the underlying
// router state — the outer router-config layer still owns the actual
// FindMyWay instance, so non-protected routes (auth, autumn, swagger) keep
// their unprefixed paths.
const PrefixedRouterLayer = Layer.effect(HttpRouter.HttpRouter)(
  Effect.map(HttpRouter.HttpRouter.asEffect(), (router) => router.prefixed("/api/:org")),
);

// `rsLive` is the per-request DB layer. Combining it into the auth
// middleware collapses `requires: DbService | UserStoreService` to
// never (so `.layer` is a real Layer instead of the "Need to combine"
// type-error sentinel) AND makes the postgres.js socket request-scoped:
// the layer rebuilds per HTTP request, satisfying Cloudflare Workers'
// I/O isolation. Exposed as a factory so tests can swap in a counting
// fake — see `apps/cloud/src/api.request-scope.node.test.ts`.
export const makeProtectedApiLive = (rsLive: Layer.Layer<DbService | UserStoreService>) => {
  const protectedMiddleware = ExecutionStackMiddleware.combine(
    requestScopedMiddleware(rsLive),
  ).layer;
  return ProtectedCloudApiLive.pipe(
    Layer.provide(protectedMiddleware),
    Layer.provide(PrefixedRouterLayer),
    Layer.provideMerge(HttpApiSwagger.layer(ProtectedCloudApi, { path: "/docs" })),
    Layer.provideMerge(RouterConfig),
  );
};

export const ProtectedApiLive = makeProtectedApiLive(RequestScopedServicesLive);
