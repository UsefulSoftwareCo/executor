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
//   - the WorkOS webhook (`/api/webhooks/workos`) — signature-verified poke of
//     the membership-mirror reconciler.
//   - the global request-failure logging middleware.
//
// They all serve UNDER the `/api` prefix (the same namespace the protected +
// account APIs use), so each HttpApi group is provided the shared
// `apiPrefixedRouter` view; the plain `HttpRouter.add` routes use literal
// `/api/...` paths. The per-request `DbService` / `UserStoreService` the session
// handlers read is supplied by `RequestScopedServicesLive` (rebuilt per request
// so the postgres.js socket lives in the request fiber's scope).
// ---------------------------------------------------------------------------

import { env, waitUntil } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApiSwagger, OpenApi } from "effect/unstable/httpapi";

import { AccountApi, AdminUsersApi } from "@executor-js/api";
import { requestScopedMiddleware, type MemberDirectory } from "@executor-js/api/server";

import { UserStoreService } from "../auth/context";
import { WorkOsMirror } from "../auth/workos-mirror";
import { CloudAuthApi, CloudAuthPublicApi } from "../auth/api";
import { runWorkOsEventsSync } from "../auth/workos-events-runner";
import { makeWorkOsWebhookRoute } from "../auth/workos-webhook";
import { makeCloudAdminUsersRoutes } from "../admin/admin-users-api";
import { OrgApi } from "../org/api";
import { DbService } from "../db/db";
import { ProtectedCloudApi } from "../api/layers";
import { AutumnRoutesLive } from "./billing/route";
import { apiPrefixedRouter, makeOrgRoutes, makeSessionRoutes } from "./session-routes";
import { ApiErrorLoggingLive } from "../observability/error-logging";

// The full cloud OpenAPI spec, prefixed so the served paths match `/api/*`.
const CloudOpenApi = ProtectedCloudApi.add(CloudAuthPublicApi)
  .add(CloudAuthApi)
  .add(OrgApi)
  .add(AccountApi)
  .add(AdminUsersApi)
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
export const makeCloudExtensionRoutes = (
  rsLive: Layer.Layer<DbService | UserStoreService | WorkOsMirror | MemberDirectory>,
) => {
  // Session + org routes, from the shared constructors the auth plane
  // (`../app-auth`) mounts too — one definition, two planes.
  const SessionRoutes = makeSessionRoutes(rsLive);
  const OrgRoutes = makeOrgRoutes(rsLive);

  // Swagger UI at /api/docs + the OpenAPI JSON at /api/openapi.json, over the
  // `/api`-prefixed spec (so the served paths match).
  const DocsRoutes = Layer.mergeAll(
    HttpApiSwagger.layer(CloudOpenApi, { path: "/api/docs" }),
    HttpRouter.add("GET", "/api/openapi.json", Effect.succeed(HttpServerResponse.jsonUnsafe(spec))),
  );

  const BillingRoutes = AutumnRoutesLive.pipe(Layer.provide(requestScopedMiddleware(rsLive).layer));

  // The tenant-wide admin plane (`/api/admin/users*`). Mounted as an extension
  // rather than on the protected API because the protected plane's middleware
  // binds a product-view executor to one acting member — this one authorizes an
  // org key (or an admin session) and builds a subject-less platform view.
  const AdminUsersRoutes = makeCloudAdminUsersRoutes(rsLive, {
    router: apiPrefixedRouter,
  });

  // The WorkOS webhook needs no per-request DB layer: it verifies the
  // signature with the boot `WorkOSClient` and detaches a reconciler pass
  // that builds its own fresh services (the route's request scope is gone by
  // the time the pass runs). `waitUntil` binds to the in-flight invocation.
  const WebhookRoutes = makeWorkOsWebhookRoute({
    secret: env.WORKOS_WEBHOOK_SECRET,
    detach: waitUntil,
    sync: runWorkOsEventsSync,
  });

  return [
    SessionRoutes,
    OrgRoutes,
    AdminUsersRoutes,
    DocsRoutes,
    BillingRoutes,
    WebhookRoutes,
    ApiErrorLoggingLive,
  ] as const;
};
