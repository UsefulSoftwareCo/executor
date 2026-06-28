import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServer } from "effect/unstable/http";
import { Layer } from "effect";

import { makeProtectedApiLayer, requestScopedMiddleware } from "@executor-js/api/server";

import { SessionAuthLive } from "../auth/middleware-live";
import { UserStoreService } from "../auth/context";
import {
  CloudAuthPublicHandlers,
  CloudSessionAuthHandlers,
  NonProtectedApi,
} from "../auth/handlers";
import { DbService } from "../db/db";
import { WorkerTelemetryLive } from "../observability/telemetry";
import { OrgHttpApi } from "../org/api";
import { orgAuthMiddleware } from "../org/auth-middleware";
import { OrgHandlers } from "../org/handlers";
import { ErrorCaptureLive } from "../observability";

import { AutumnService } from "../extensions/billing/service";

import { cloudPlugins } from "../plugins";
import { CoreSharedServices } from "../auth/workos";

const DbLive = DbService.Live;
const UserStoreLive = UserStoreService.Live.pipe(Layer.provide(DbLive));

// Per-request layer. Anything that opens an I/O object (postgres.js socket,
// fetch stream readers, anything backed by a `Writable`) MUST live here —
// `provideRequestScoped` rebuilds it per request so Cloudflare Workers'
// I/O isolation is satisfied. See `api.request-scope.test.ts`.
export const RequestScopedServicesLive = Layer.mergeAll(DbLive, UserStoreLive);

// Boot-scoped layer. Built once at worker boot, reused across requests.
// Safe for config, in-memory caches, the global tracer provider, and
// stateless service shells.
export const BootSharedServices = Layer.mergeAll(
  CoreSharedServices,
  HttpServer.layerServices,
  WorkerTelemetryLive,
);

// Routes that don't require an authenticated org session — login,
// callbacks, etc. Mounts at the paths declared inside `NonProtectedApi`.
//
// `rsLive` is the per-request DB layer. It's passed in as a parameter so
// tests can substitute a counting fake for `DbService.Live` and assert
// per-request semantics. Handlers here yield `UserStoreService` directly;
// without per-request scoping the postgres.js socket pins to the worker's
// boot scope and Cloudflare Workers' I/O isolation kills the second
// request.
//
// `AutumnService.Default` is provided HERE because the `createOrganization`
// handler reads it for the free-organizations-per-user limit gate — one of the
// few app-only billing touchpoints. (It is NOT on the neutral boot core.)
export const makeNonProtectedApiLive = (rsLive: Layer.Layer<DbService | UserStoreService>) =>
  HttpApiBuilder.layer(NonProtectedApi).pipe(
    Layer.provide(Layer.mergeAll(CloudAuthPublicHandlers, CloudSessionAuthHandlers)),
    Layer.provide(requestScopedMiddleware(rsLive).layer),
    Layer.provideMerge(SessionAuthLive),
    Layer.provideMerge(AutumnService.Default),
  );

// Cloud-only WorkOS domain-verification routes. Auth is enforced by a router
// middleware that resolves the URL org selector header before falling back to
// the session org, so slug lookup uses the same per-request UserStoreService as
// the account and protected APIs. The `getDomainVerificationLink` handler also
// gates on billing, so `AutumnService.Default` is provided here, not on the
// neutral boot core.
export const makeOrgApiLive = (rsLive: Layer.Layer<DbService | UserStoreService>) =>
  HttpApiBuilder.layer(OrgHttpApi).pipe(
    Layer.provide(OrgHandlers),
    Layer.provide(orgAuthMiddleware(rsLive)),
    Layer.provideMerge(AutumnService.Default),
  );

// Default export uses the production per-request layer. Existing callers that
// import `NonProtectedApiLive` continue to work; the `make*` factory exists for
// tests that need to swap in a fake.
export const NonProtectedApiLive = makeNonProtectedApiLive(RequestScopedServicesLive);
export const OrgApiLive = makeOrgApiLive(RequestScopedServicesLive);

// ---------------------------------------------------------------------------
// Protected API
// ---------------------------------------------------------------------------
//
// `ProtectedCloudApi` deliberately does NOT declare `.middleware(OrgAuth)`
// — auth + per-request execution stack construction live in a single
// `HttpRouter` middleware (`ExecutionStackMiddleware` in `./protected.ts`)
// which has the right ordering to provide `AuthContext` AND the executor
// services to handlers. Putting auth on the API as `HttpApiMiddleware` ran
// it INSIDE the router middleware (wrong order), and added a second auth
// pass on top of the existing one in `protected.ts`'s outer effect. The
// router-middleware approach folds both into one place.
//
// The shared `makeProtectedApiLayer` assembles the protected API the same way
// every host does: `composePluginApi(cloudPlugins)` ->
// `observabilityMiddleware` -> `HttpApiBuilder.layer` provided with
// `CoreHandlers` + `composePluginHandlerLayer(cloudPlugins)` + the host's
// `ErrorCapture` + `RouterConfigLive`. Cloud serves at root (no prefixed
// router) and passes the Sentry-backed `ErrorCaptureLive` (provided ABOVE the
// handler + middleware layers, so the `capture(...)` translation path AND the
// observability middleware's defect catchall both resolve the same Sentry
// implementation).
//
// `api` is precisely typed (`HttpApi<…, CoreGroups | PluginGroups<typeof
// cloudPlugins>>`); test harness clients type via
// `HttpApiClient.ForApi<typeof ProtectedCloudApi>` with no per-plugin imports.
// `handlers` is the late-binding plugin handler Layer (each plugin's
// `extensionService` Tag stays a requirement, satisfied per-request by
// `ExecutionStackMiddleware` in `./protected.ts`). `RouterConfigLive` is
// folded into `.layer` here; the rest of the router (`makeApiLive` in
// `./router.ts`, `./protected.ts`, the test harness) re-provides the same
// shared `RouterConfigLive` directly.
const protectedApi = makeProtectedApiLayer(cloudPlugins, { errorCapture: ErrorCaptureLive });

export const ProtectedCloudApi = protectedApi.api;
export const ProtectedCloudApiHandlers = protectedApi.handlers;
export const ProtectedCloudApiLive = protectedApi.layer;
