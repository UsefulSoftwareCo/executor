import { Layer } from "effect";

import { toApiHandler } from "@executor-js/api/server";

import { RequestScopedServicesLive } from "./api/request-scoped";
import { CoreSharedServices } from "./auth/workos";
import { makeOrgRoutes, makeSessionRoutes } from "./extensions/session-routes";
import { ApiErrorLoggingLive } from "./observability/error-logging";
import { WorkerTelemetryLive } from "./observability/telemetry";

// ===========================================================================
// The Executor cloud AUTH plane — the session/auth surface on its own handler.
//
// Why a second handler instead of a lazier `./app`: Effect's `HttpApiBuilder`
// registers every group into one router at layer-BUILD time, so the first
// `/api/*` request that reaches `ExecutorApp.make`'s handler evaluates the
// whole composition — plugin + OpenAPI + MCP + GraphQL catalogs, the execution
// substrate (@babel/parser, sucrase), Swagger. A lazy split inside a single
// `HttpApi` is not expressible. The seam that IS expressible is the worker
// entry, where `servedByAppPlane` (./app-paths) already decides which paths
// skip TanStack Start — so `servedByAuthPlane` names the session routes and
// `server.ts` dispatches them here first.
//
// Measured on production 2026-09-18 for `/api/*` on the app plane: warm p50
// ~120ms, cold p50 ~2.2s, ~31% of requests cold. `POST /api/auth/logout` is
// the user-visible victim — the console posts it as a top-level form
// navigation, so the cold wait is a blank page.
//
// What makes the two planes agree on the wire: they mount the SAME Layer
// values. `makeSessionRoutes` / `makeOrgRoutes` (./extensions/session-routes)
// are the exact constructors `makeCloudExtensionRoutes` feeds to
// `ExecutorApp.make`, on the same `/api`-prefixed router view, over the same
// `RequestScopedServicesLive`. Nothing is re-derived here.
//
// What this plane deliberately does NOT carry, because these routes never read
// it: the protected (plugin) API and its execution-stack middleware, the
// neutral `IdentityProvider` + `cloudIdentityFailureStrategy` (session routes
// authenticate through `SessionAuth`, whose `Unauthorized` is rendered by the
// HttpApi machinery, not by the identity failure strategy), the MCP envelope,
// Swagger/OpenAPI, the billing proxy, the admin plane, and the WorkOS webhook.
// `ErrorCapture` is absent for the same reason — no route here resolves that
// tag (`captureCauseEffect` is a plain Effect and needs no service).
//
// `HttpMiddleware.tracer`'s `http.server` span still opens per request:
// `toApiHandler` -> `HttpRouter.toWebHandler` installs it exactly as it does
// for `./app`, so an auth-plane request traces like an app-plane one.
// ===========================================================================

// Boot-scoped context, the auth-plane subset of `./app`'s `boot`: the raw
// WorkOS SDK client the session handlers and `SessionAuthLive` read, plus the
// worker tracer. No api-key service (no Bearer plane here), no `AutumnService`
// on the core — `makeSessionRoutes` provide-merges its own, exactly as it does
// inside the full app. `HttpServer.layerServices` is supplied by
// `toApiHandler`. A boot-time WorkOS misconfig is unrecoverable -> `orDie`.
const authBoot = Layer.merge(CoreSharedServices, WorkerTelemetryLive).pipe(
  // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: a boot-time WorkOS misconfiguration is unrecoverable
  Layer.orDie,
);

const AuthPlaneLayer = Layer.mergeAll(
  makeSessionRoutes(RequestScopedServicesLive),
  makeOrgRoutes(RequestScopedServicesLive),
  // The same global request-failure logging the app plane mounts, so a failing
  // session route logs identically on either plane.
  ApiErrorLoggingLive,
).pipe(Layer.provideMerge(authBoot));

/**
 * The auth-plane web handler: serves exactly the paths `servedByAuthPlane`
 * (./app-paths) names — `/api/auth/*`, `/api/org/domains*`, and the MCP
 * approval endpoints. Everything else under `/api` stays on `./app`.
 */
export const cloudAuthHandler = () => toApiHandler(AuthPlaneLayer);
