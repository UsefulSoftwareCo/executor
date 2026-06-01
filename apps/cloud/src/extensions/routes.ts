// ---------------------------------------------------------------------------
// Cloud's app-only HTTP surface — the `extensions.routes` fed to
// `ExecutorApp.make`. None of these are seams the shared core names; they are
// cloud-specific routes mounted alongside the executor `/api/*` plane:
//
//   - the WorkOS session routes (login / callback / me / organizations /
//     switch-organization / invitations / MCP-approval) — `NonProtectedApi`.
//   - the cloud-only WorkOS domain-verification routes — `OrgHttpApi`.
//   - Swagger UI + the OpenAPI JSON for the full cloud spec.
//   - the Autumn billing proxy (`/api/billing/*`) — billing-as-extension (the
//     `extensions.routes` SEAM, but served under `/api` like everything else).
//   - the global request-failure logging middleware.
//
// They all serve UNDER the `/api` prefix (the same namespace the protected +
// account APIs use), so each HttpApi group is provided the shared
// `apiPrefixedRouter` view; the plain `HttpRouter.add` routes use literal
// `/api/...` paths. The per-request `DbService` / `UserStoreService` the session
// handlers read is supplied by `RequestScopedServicesLive` (rebuilt per request
// so the postgres.js socket lives in the request fiber's scope).
// ---------------------------------------------------------------------------

import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpApiSwagger, OpenApi } from "effect/unstable/httpapi";

import { requestScopedMiddleware } from "@executor-js/api/server";

import { UserStoreService } from "../auth/context";
import {
  CloudAuthPublicHandlers,
  CloudSessionAuthHandlers,
  NonProtectedApi,
} from "../auth/handlers";
import { CloudAuthApi, CloudAuthPublicApi } from "../auth/api";
import { OrgAuthLive, SessionAuthLive } from "../auth/middleware-live";
import { OrgApi, OrgHttpApi } from "../org/api";
import { OrgHandlers } from "../org/handlers";
import { AutumnService } from "../extensions/billing/service";
import { DbService } from "../db/db";
import { ProtectedCloudApi } from "../api/layers";
import { AutumnRoutesLive } from "./billing/route";
import { ApiErrorLoggingLive } from "../observability/error-logging";

// The `/api`-prefixed `HttpRouter` view every cloud HttpApi group registers on,
// so `/auth/me` serves at `/api/auth/me` (matching the protected + account
// plane). Derived from the ambient router, exactly as `ExecutorApp.make` builds
// its own internal prefixed view for the protected API.
const apiPrefixedRouter = Layer.effect(HttpRouter.HttpRouter)(
  Effect.map(HttpRouter.HttpRouter.asEffect(), (router) => router.prefixed("/api")),
);

// The full cloud OpenAPI spec, prefixed so the served paths match `/api/*`.
const CloudOpenApi = ProtectedCloudApi.add(CloudAuthPublicApi)
  .add(CloudAuthApi)
  .add(OrgApi)
  .prefix("/api");

const spec = OpenApi.fromApi(CloudOpenApi);

/**
 * Build cloud's app-only extension routes. `rsLive` is the per-request DB layer
 * the session handlers read; passed in so tests can swap a counting fake.
 *
 * `AutumnService.Default` is provided to the session + org groups because the
 * `createOrganization` free-limit gate and the domain-verification-link gate
 * read it — the few app-only billing touchpoints. It is NOT on the neutral boot
 * core.
 */
export const makeCloudExtensionRoutes = (rsLive: Layer.Layer<DbService | UserStoreService>) => {
  // Session routes (login / callback / me / switch-org / …). Handlers yield
  // `UserStoreService` directly; the per-request DB combine keeps the postgres
  // socket request-scoped.
  const SessionRoutes = HttpApiBuilder.layer(NonProtectedApi).pipe(
    Layer.provide(Layer.mergeAll(CloudAuthPublicHandlers, CloudSessionAuthHandlers)),
    Layer.provide(requestScopedMiddleware(rsLive).layer),
    Layer.provideMerge(SessionAuthLive),
    Layer.provideMerge(AutumnService.Default),
    Layer.provide(apiPrefixedRouter),
  );

  // Cloud-only WorkOS domain-verification routes; `OrgAuth` enforces an
  // authenticated org session. No per-request DB scoping needed.
  const OrgRoutes = HttpApiBuilder.layer(OrgHttpApi).pipe(
    Layer.provide(OrgHandlers),
    Layer.provideMerge(OrgAuthLive),
    Layer.provideMerge(AutumnService.Default),
    Layer.provide(apiPrefixedRouter),
  );

  // Swagger UI at /api/docs + the OpenAPI JSON at /api/openapi.json, over the
  // `/api`-prefixed spec (so the served paths match).
  const DocsRoutes = Layer.mergeAll(
    HttpApiSwagger.layer(CloudOpenApi, { path: "/api/docs" }),
    HttpRouter.add("GET", "/api/openapi.json", Effect.succeed(HttpServerResponse.jsonUnsafe(spec))),
  );

  return [SessionRoutes, OrgRoutes, DocsRoutes, AutumnRoutesLive, ApiErrorLoggingLive] as const;
};
