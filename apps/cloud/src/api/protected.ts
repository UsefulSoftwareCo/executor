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
import { ApiKeyService } from "../auth/api-keys";
import { authorizeOrganization } from "../auth/authorize-organization";
import { UserStoreService } from "../auth/context";
import { WorkOSAuth } from "../auth/workos";
import { AutumnService } from "../services/autumn";
import { DbService } from "../services/db";
import { makeExecutionStack } from "../services/execution-stack";
import { HttpResponseError } from "./error-response";
import { RequestScopedServicesLive } from "./layers";
import { ProtectedCloudApi, ProtectedCloudApiLive, RouterConfig } from "./protected-layers";
import { requestScopedMiddleware } from "./request-scoped";

// Pre-compute the per-plugin `Effect.provideService(extensionService,
// executor[id])` chain. The plugin spec carries the Service tag so
// this file doesn't import each plugin's `*/api` directly.
const provideExecutorExtensions = providePluginExtensions(cloudPlugins);
const BEARER_PREFIX = "Bearer ";

export const resolveApiKeyIdentity = (request: Request) =>
  Effect.gen(function* () {
    const authHeader = request.headers.get("authorization");
    if (!authHeader) return null;

    if (!authHeader.startsWith(BEARER_PREFIX)) {
      return yield* new HttpResponseError({
        status: 401,
        code: "invalid_authorization_header",
        message: "Authorization header must use Bearer authentication",
      });
    }

    const value = authHeader.slice(BEARER_PREFIX.length).trim();
    if (!value) {
      return yield* new HttpResponseError({
        status: 401,
        code: "invalid_api_key",
        message: "Invalid API key",
      });
    }

    const apiKeys = yield* ApiKeyService;
    const principal = yield* apiKeys.validate(value).pipe(
      Effect.catchTag("ApiKeyValidationError", () =>
        Effect.fail(
          new HttpResponseError({
            status: 503,
            code: "api_key_validation_unavailable",
            message: "API key validation is temporarily unavailable",
          }),
        ),
      ),
    );

    if (!principal) {
      return yield* new HttpResponseError({
        status: 401,
        code: "invalid_api_key",
        message: "Invalid API key",
      });
    }

    const org = yield* authorizeOrganization(principal.accountId, principal.organizationId);
    if (!org) {
      return yield* new HttpResponseError({
        status: 403,
        code: "no_organization",
        message: "No organization in API key",
      });
    }

    return {
      accountId: principal.accountId,
      organizationId: org.id,
      organizationName: org.name,
      email: "",
      name: null,
      avatarUrl: null,
    };
  });

export const resolveSessionIdentity = (request: Request) =>
  Effect.gen(function* () {
    const workos = yield* WorkOSAuth;
    const session = yield* workos.authenticateRequest(request);
    if (!session || !session.organizationId) {
      return yield* new HttpResponseError({
        status: 403,
        code: "no_organization",
        message: "No organization in session",
      });
    }
    const org = yield* authorizeOrganization(session.userId, session.organizationId);
    if (!org) {
      return yield* new HttpResponseError({
        status: 403,
        code: "no_organization",
        message: "No organization in session",
      });
    }
    return {
      accountId: session.userId,
      organizationId: org.id,
      organizationName: org.name,
      email: session.email,
      name: `${session.firstName ?? ""} ${session.lastName ?? ""}`.trim() || null,
      avatarUrl: session.avatarUrl ?? null,
    };
  });

export const resolveProtectedIdentity = (request: Request) =>
  Effect.gen(function* () {
    const apiKeyIdentity = yield* resolveApiKeyIdentity(request);
    if (apiKeyIdentity) return apiKeyIdentity;
    return yield* resolveSessionIdentity(request);
  });

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
    const longLived = yield* Effect.context<WorkOSAuth | AutumnService | ApiKeyService>();
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const webRequest = yield* HttpServerRequest.toWeb(request);
        const identity = yield* resolveProtectedIdentity(webRequest);
        const auth = AuthContext.of({
          accountId: identity.accountId,
          organizationId: identity.organizationId,
          email: identity.email,
          name: identity.name,
          avatarUrl: identity.avatarUrl,
        });
        const { executor, engine } = yield* makeExecutionStack(
          auth.accountId,
          identity.organizationId,
          identity.organizationName,
        );
        return yield* httpEffect.pipe(
          Effect.provideService(AuthContext, auth),
          Effect.provideService(ExecutorService, executor),
          Effect.provideService(ExecutionEngineService, engine),
          provideExecutorExtensions(executor),
        );
      }).pipe(Effect.provideContext(longLived));
  }),
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
    Layer.provideMerge(ApiKeyService.WorkOS),
    Layer.provideMerge(HttpApiSwagger.layer(ProtectedCloudApi, { path: "/docs" })),
    Layer.provideMerge(RouterConfig),
  );
};

export const ProtectedApiLive = makeProtectedApiLive(RequestScopedServicesLive);
