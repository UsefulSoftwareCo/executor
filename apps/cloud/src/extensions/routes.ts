// ---------------------------------------------------------------------------
// Cloud's app-only HTTP surface — the `extensions.routes` fed to
// `ExecutorApp.make`. None of these are seams the shared core names; they are
// cloud-specific routes mounted alongside the executor `/api/*` plane:
//
//   - the WorkOS session routes (login / callback / me / organizations /
//     switch-organization / invitations / MCP-approval) — `NonProtectedApi`.
//   - the cloud-only WorkOS domain-verification routes — `OrgHttpApi`.
//   - Swagger UI + the OpenAPI JSON for the full cloud spec (lazy).
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
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi";

import { AccountApi, AdminUsersApi } from "@executor-js/api";
import { requestScopedMiddleware, type MemberDirectory } from "@executor-js/api/server";

import { UserStoreService } from "../auth/context";
import { WorkOsMirror } from "../auth/workos-mirror";
import {
  CloudAuthPublicHandlers,
  CloudSessionAuthHandlers,
  NonProtectedApi,
} from "../auth/handlers";
import { CloudAuthApi, CloudAuthPublicApi } from "../auth/api";
import { SessionAuthLive } from "../auth/middleware-live";
import { runWorkOsEventsSync } from "../auth/workos-events-runner";
import { makeWorkOsWebhookRoute } from "../auth/workos-webhook";
import { makeCloudAdminUsersRoutes } from "../admin/admin-users-api";
import { OrgApi, OrgHttpApi } from "../org/api";
import { orgAuthMiddleware } from "../org/auth-middleware";
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

// ---------------------------------------------------------------------------
// Docs, built on demand.
//
// Nothing below runs until someone asks for `/api/docs` or `/api/openapi.json`.
// Both were previously built at module scope, so every cold isolate paid for
// two routes almost nobody calls: `OpenApi.fromApi` walks all ~91 endpoints,
// and effect's Swagger UI bundle is a single ~2 MB string literal that the
// isolate had to evaluate before serving any request. The bundle now arrives
// through a dynamic import, which keeps it out of the app plane's static
// closure entirely.
//
// Each step is memoized for the life of the isolate, so a second docs request
// is as cheap as the old module-scope version.
// ---------------------------------------------------------------------------

/** Build `build()` at most once per isolate. */
const once = <A>(build: () => A): (() => A) => {
  let cell: { readonly value: A } | undefined;
  return () => (cell ??= { value: build() }).value;
};

// The full cloud OpenAPI spec, prefixed so the served paths match `/api/*`.
const cloudOpenApi = once(() =>
  ProtectedCloudApi.add(CloudAuthPublicApi)
    .add(CloudAuthApi)
    .add(OrgApi)
    .add(AccountApi)
    .add(AdminUsersApi)
    .prefix("/api"),
);

const openApiSpec = once(() => OpenApi.fromApi(cloudOpenApi()));

// The two escapes effect applies before interpolating into the page. Copied
// rather than imported because they live in an internal module; they are three
// lines and their behaviour is fixed by the HTML they guard.
const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeSpecJson = (value: unknown) =>
  JSON.stringify(value)
    .replace(/<\/script>/gi, "<\\/script>")
    .replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));

let docsHtml: string | undefined;

/**
 * The Swagger UI page. Mirrors what `HttpApiSwagger.layer` renders — same
 * shell, same inlined bundle, same inlined spec — so the served page is
 * byte-identical to the layer this route replaced.
 */
const renderDocsHtml = async () => {
  if (docsHtml !== undefined) return docsHtml;
  // The ~2 MB Swagger UI bundle. Loaded here so it never enters the statically
  // reachable module graph of a cold isolate.
  const swaggerUi =
    (await import("effect/unstable/httpapi/internal/httpApiSwagger")) as unknown as {
      readonly css: string;
      readonly javascript: string;
    };
  const spec = openApiSpec();
  docsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(spec.info.title)} Documentation</title>
  <style>${swaggerUi.css}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script id="swagger-spec" type="application/json">
    ${escapeSpecJson(spec)}
  </script>
  <script>
    ${swaggerUi.javascript}
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        spec: JSON.parse(document.getElementById("swagger-spec").textContent),
        dom_id: "#swagger-ui",
      });
    };
  </script>
</body>
</html>`;
  return docsHtml;
};

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

  // Cloud-only WorkOS domain-verification routes; the auth middleware resolves
  // the URL org selector header before falling back to the session org, so slug
  // lookup needs the same request-scoped UserStoreService as other org-scoped
  // APIs.
  const OrgRoutes = HttpApiBuilder.layer(OrgHttpApi).pipe(
    Layer.provide(OrgHandlers),
    Layer.provide(orgAuthMiddleware(rsLive)),
    Layer.provideMerge(AutumnService.Default),
    Layer.provide(apiPrefixedRouter),
  );

  // Swagger UI at /api/docs + the OpenAPI JSON at /api/openapi.json, over the
  // `/api`-prefixed spec (so the served paths match). Both bodies are built on
  // the first request that asks for them — see the block above.
  const DocsRoutes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/api/docs",
      Effect.map(
        Effect.promise(() => renderDocsHtml()),
        (html) => HttpServerResponse.html(html),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/api/openapi.json",
      Effect.sync(() => HttpServerResponse.jsonUnsafe(openApiSpec())),
    ),
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
