import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServer } from "effect/unstable/http";
import { Layer } from "effect";

import { OrgAuthLive, SessionAuthLive } from "../auth/middleware-live";
import { ApiKeyService } from "../auth/api-keys";
import { UserStoreService } from "../auth/context";
import {
  CloudAuthPublicHandlers,
  CloudSessionAuthHandlers,
  NonProtectedApi,
} from "../auth/handlers";
import { DbService } from "../services/db";
import { TelemetryLive } from "../services/telemetry";
import { OrgHttpApi } from "../org/compose";
import { OrgHandlers } from "../org/handlers";

import { CoreSharedServices } from "./core-shared-services";
import { ProtectedCloudApi, RouterConfig } from "./protected-layers";
import { requestScopedMiddleware } from "./request-scoped";

export { CoreSharedServices, ProtectedCloudApi, RouterConfig };

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
  TelemetryLive,
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
export const makeNonProtectedApiLive = (rsLive: Layer.Layer<DbService | UserStoreService>) =>
  HttpApiBuilder.layer(NonProtectedApi).pipe(
    Layer.provide(Layer.mergeAll(CloudAuthPublicHandlers, CloudSessionAuthHandlers)),
    Layer.provideMerge(ApiKeyService.WorkOS),
    Layer.provide(requestScopedMiddleware(rsLive).layer),
    Layer.provideMerge(SessionAuthLive),
  );

// Routes scoped to a specific org (membership management, switching, etc.).
// Auth is enforced by `OrgAuth` middleware declared on `OrgHttpApi`.
export const makeOrgApiLive = (rsLive: Layer.Layer<DbService | UserStoreService>) =>
  HttpApiBuilder.layer(OrgHttpApi).pipe(
    Layer.provide(OrgHandlers),
    Layer.provide(requestScopedMiddleware(rsLive).layer),
    Layer.provideMerge(OrgAuthLive),
  );

// Default exports use the production per-request layer. Existing callers
// that import `NonProtectedApiLive`/`OrgApiLive` continue to work; the
// `make*` factories exist for tests that need to swap in a fake.
export const NonProtectedApiLive = makeNonProtectedApiLive(RequestScopedServicesLive);
export const OrgApiLive = makeOrgApiLive(RequestScopedServicesLive);
