// ---------------------------------------------------------------------------
// Shared host-boot API foundation.
//
// Every product host (cloud, self-host, local) assembles the same protected
// API the same way:
//
//   composePluginApi(plugins)
//     -> observabilityMiddleware(api)            (defect safety net)
//     -> HttpApiBuilder.layer(api)               (the routes)
//          + CoreHandlers + composePluginHandlerLayer(plugins)
//          + ErrorCapture (Sentry / console / in-memory)
//          + RouterConfigLive                    (maxParamLength bump)
//
// They differ only in three knobs:
//   - `errorCapture` — the host's `ErrorCapture` impl (Sentry vs console).
//   - `router`       — an optional prefixed `HttpRouter` view (self-host
//                      serves under `/api`; cloud/local serve at root).
//   - the plugin set — typed straight off the passed tuple.
//
// The account API mounts the same provider-neutral `AccountHandlers` behind a
// per-request `AccountProvider`, again differing only by the optional router and
// the service-providing layer.
//
// `toApiHandler` is the `HttpRouter.toWebHandler(appLayer + platform)` boiler-
// plate that every web-handler binding repeats: build, expose `{ handler,
// dispose }`. The per-host listening adapters (TanStack Start request
// middleware, the Bun socket) stay app-specific.
//
// NOTE: this module intentionally imports nothing host-specific (no
// `cloudflare:workers`, no Bun platform), so it stays importable from the
// Workers test runtime and from every host.
// ---------------------------------------------------------------------------

import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { Layer } from "effect";
import type { AnyPlugin } from "@executor-js/sdk";

import { observabilityMiddleware, type ErrorCapture } from "../observability";
import { AccountHttpApi } from "../account/api";
import { AccountHandlers } from "../account/handlers";
import type { AccountProvider } from "../account/service";
import { composePluginApi, composePluginHandlerLayer } from "../plugin-routes";
import { CoreHandlers } from "../handlers";
import { requestScopedMiddleware } from "./request-scoped";
import { RouterConfigLive } from "./router-config";

// `HttpApiBuilder.layer` requires `HttpRouter.HttpRouter`; a host that serves
// the API under a path prefix passes a `router.prefixed("/api")` view as this
// layer so every route carries the prefix. Hosts serving at root omit it (the
// ambient default `HttpRouter` is used). The prefixed view DERIVES from the
// ambient router, so it both provides and requires `HttpRouter.HttpRouter`
// (self-host's `PrefixedRouterLive`). Keeping the requirement channel precise
// (not `any`) avoids leaking `any` into every assembled host layer.
type RouterLayer = Layer.Layer<HttpRouter.HttpRouter, never, HttpRouter.HttpRouter>;

// ---------------------------------------------------------------------------
// Protected (plugin) API
// ---------------------------------------------------------------------------

export interface MakeProtectedApiLayerOptions {
  /**
   * The host's `ErrorCapture` implementation. Provided ABOVE the handler +
   * middleware layers so both the `capture(...)` typed-channel translation
   * (`StorageError -> InternalError(traceId)`) AND the observability
   * middleware's defect catchall resolve the same backend.
   */
  readonly errorCapture: Layer.Layer<ErrorCapture>;
  /**
   * Optional prefixed `HttpRouter` view (e.g. `router.prefixed("/api")`). When
   * present every API route serves under that prefix. Omit to serve at root.
   */
  readonly router?: RouterLayer;
}

/**
 * Assemble the protected (plugin) API into its boot Layer.
 *
 * Wires, in order: `composePluginApi(plugins)` ->
 * `observabilityMiddleware(api)` -> `HttpApiBuilder.layer(api)` provided with
 * `CoreHandlers` + `composePluginHandlerLayer(plugins)` + the host's
 * `ErrorCapture` + `RouterConfigLive` (+ the optional prefixed router).
 *
 * Returns `{ api, handlers, layer }` because hosts consume all three
 * independently:
 *   - `api`      — the composed `HttpApi` value, reused for Swagger/OpenAPI,
 *                  `.prefix(...)` spec views, `HttpApiClient.ForApi`, and
 *                  `.add(...)` of host-only groups (cloud docs).
 *   - `handlers` — `CoreHandlers` + every plugin's late-binding `handlers()`
 *                  Layer; reused by test harnesses building against a fake
 *                  middleware.
 *   - `layer`    — the wired boot Layer. The plugin handler Layers stay
 *                  late-binding (they require each plugin's `*ExtensionService`
 *                  Tag), so the host provides its per-request execution-stack
 *                  middleware on this `layer` itself.
 */
export const makeProtectedApiLayer = <TPlugins extends readonly AnyPlugin[]>(
  plugins: TPlugins,
  options: MakeProtectedApiLayerOptions,
) => {
  const api = composePluginApi(plugins);
  const handlers = Layer.mergeAll(CoreHandlers, composePluginHandlerLayer(plugins));

  // `RouterConfigLive` is folded in here so every host gets the raised
  // `maxParamLength` without re-wiring it; the optional prefixed router is
  // merged alongside it so `HttpApiBuilder.layer`'s `HttpRouter` requirement is
  // satisfied by the prefixed view when the host wants a path namespace.
  const routerSupport = options.router
    ? Layer.merge(RouterConfigLive, options.router)
    : RouterConfigLive;

  const layer = HttpApiBuilder.layer(api).pipe(
    Layer.provide(Layer.mergeAll(handlers, observabilityMiddleware(api))),
    Layer.provide(options.errorCapture),
    Layer.provide(routerSupport),
  );

  return { api, handlers, layer };
};

// ---------------------------------------------------------------------------
// Account API
// ---------------------------------------------------------------------------

export interface MakeAccountApiLayerOptions {
  /**
   * Optional prefixed `HttpRouter` view, matching the protected API's prefix so
   * the account routes register on the same `/api`-prefixed router.
   */
  readonly router?: RouterLayer;
}

/**
 * Mount the shared, provider-neutral `AccountHandlers` (me / API keys / org)
 * behind a per-request `AccountProvider`:
 *
 *   HttpApiBuilder.layer(AccountHttpApi)
 *     -> AccountHandlers
 *     -> the `AccountProvider`-providing middleware
 *     -> (optional) prefixed router
 *
 * `accountProviderMiddleware` is the router-middleware Layer that provides
 * `AccountProvider` per request — `requestScopedMiddleware(accountProviderLayer)
 * .layer` for the self-contained case (self-host's Better Auth service), or a
 * bespoke middleware combined with `requestScopedMiddleware` (cloud builds the
 * WorkOS service INSIDE the request body so it closes over the per-request
 * postgres socket). Going through a router middleware means the handler's
 * `AccountProvider` requirement is satisfied per-request WITHOUT leaking into the
 * app layer's output requirements (a plain `Layer.provide` on the builder layer
 * would leak it and break the host build).
 *
 * The middleware's three channels are generic (`MOut`/`ME`/`MR`) so the
 * provided `Request.From<"Requires", AccountProvider>` marker AND each host's
 * remaining requirements (cloud's long-lived control-plane + billing services,
 * self-host's `never`) flow through precisely — a non-generic
 * `Layer<any, any, any>` parameter would widen the requirement channel to `any`
 * and break the host build's leftover-requirement tracking.
 *
 * Use `accountProviderMiddlewareLayer(accountProviderLayer)` for the common case.
 */
export const makeAccountApiLayer = <MOut, ME, MR>(
  accountProviderMiddleware: Layer.Layer<MOut, ME, MR>,
  options: MakeAccountApiLayerOptions = {},
) => {
  const base = HttpApiBuilder.layer(AccountHttpApi).pipe(
    Layer.provide(AccountHandlers),
    Layer.provide(accountProviderMiddleware),
  );
  return options.router ? base.pipe(Layer.provide(options.router)) : base;
};

/**
 * The common-case `AccountProvider` middleware: wrap a self-contained
 * `Layer<AccountProvider>` in `requestScopedMiddleware` and take its `.layer`.
 * (Hosts whose service must be built inside the request body — cloud — combine
 * their own middleware with `requestScopedMiddleware` and pass that instead.)
 */
export const accountProviderMiddlewareLayer = (
  accountProviderLayer: Layer.Layer<AccountProvider>,
) => requestScopedMiddleware(accountProviderLayer).layer;

// ---------------------------------------------------------------------------
// App-layer web-handler binding
// ---------------------------------------------------------------------------

export interface ApiHandler {
  readonly handler: (request: Request) => Promise<Response>;
  readonly dispose: () => Promise<void>;
}

/**
 * Bind a fully-assembled app `Layer` to a `fetch`-style web handler.
 *
 * This is the `HttpRouter.toWebHandler(appLayer + HttpServer.layerServices)`
 * boilerplate every web-handler binding repeats: the web-handler binding
 * supplies the HTTP platform services itself (no listening socket), then
 * exposes `{ handler, dispose }`. Hosts that bind to a listening socket
 * (self-host's Bun server) keep their own platform layer and DON'T use this.
 *
 * `appLayer` must already provide every `HttpRouter`/route requirement; this
 * only adds `HttpServer.layerServices` so `toWebHandler` can run handlers off a
 * synthetic platform.
 */
export const toApiHandler = (
  // The app layer must already provide every route requirement; only the HTTP
  // platform is missing, which `HttpServer.layerServices` supplies below. Typed
  // loosely (success/error/requirement channels erased) because each host's app
  // layer has a different, fully-resolved set — self-host's `AppLayer` outputs
  // `never`, local's outputs `ExecutorService | …` (provideMerge keeps them in
  // the success channel). The runtime contract is the same either way.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  appLayer: Layer.Layer<any, any, any>,
): ApiHandler => {
  // `HttpServer.layerServices` supplies the synthetic HTTP platform so
  // `toWebHandler` can run handlers without a listening socket.
  const web = HttpRouter.toWebHandler(appLayer.pipe(Layer.provideMerge(HttpServer.layerServices)));
  // With every requirement provided the leftover `HR` is `never`, so `handler`
  // is the one-arg `(request) => Promise<Response>` form — but the loose
  // `R = any` input widens `HR` to `any` (a two-arg signature), so narrow back
  // to the runtime contract.
  const handler = web.handler as (request: Request) => Promise<Response>;
  return { handler, dispose: web.dispose };
};
