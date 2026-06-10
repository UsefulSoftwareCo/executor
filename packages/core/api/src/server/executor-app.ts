// ---------------------------------------------------------------------------
// ExecutorApp.make — the single composition facade every product host calls.
//
// One codebase, three scenarios: cloud / self-host / local are the SAME code
// paths; the difference is a list of injected Layers. `ExecutorApp.make` is the
// shared assembly those Layers slot into — a newcomer reads ONE `make({ … })`
// call and sees the whole scenario (which identity, which DB, which code
// substrate, which MCP, billing present or absent).
//
// It does exactly what each host's hand-rolled composition root did before:
//
//   1. execution stack Layer  = db + engine.codeExecutor + engine.decorator
//                               + plugins.provider + plugins.config            (the makeExecutionStack seams)
//   2. ExecutionStackMiddleware = makeExecutionStackMiddleware(identity-authenticate
//                               + that stack + plugin tuple + failure strategy) (auth + per-request executor)
//   3. the protected (plugin) API = makeProtectedApiLayer(plugins, { errorCapture,
//                               router: prefixed(mountPrefix) }) wrapped by (2)
//   4. the MCP serving envelope = McpServingRoutes + the 2-3 seams (auth/sessions
//                               /reporter), double-provided like the host did      (the seams)
//   5. the account API = makeAccountApiLayer(accountMiddleware, { router })
//   6. each extensions.route (Better Auth handler, Swagger, marketing, /autumn)
//   7. provideMerge(boot) (+ optional requestScoped) -> the AppLayer
//   8. toApiHandler(appLayer) -> { handler, dispose } (web-handler binding)
//
// SEAM vs EXTENSION (the grouping teaches the line):
//   - `providers.*`  = named slots whose Layer satisfies a tag the shared core
//                      RESOLVES (identity, account, db, engine, mcp, plugins,
//                      errorCapture). The app picks the impl; the core names the
//                      tag. `errorCapture` IS a seam — the core resolves it.
//   - `extensions.*` = surface the core never names (routes/services). Better
//                      Auth's /api/auth handler, Swagger, cloud's marketing +
//                      /autumn billing live here. The shared core never imports
//                      them.
//
// `mountPrefix` is a STRING ("/api"); make() builds the `router.prefixed(...)`
// view internally so a host never hand-writes path stripping. `mcpExport` is the
// escape hatch for a platform-only export (cloud's Durable Object class) that the
// runtime needs surfaced but the shared core never names — make() passes it back
// out untouched.
// ---------------------------------------------------------------------------

import { HttpRouter } from "effect/unstable/http";
import { Effect, Layer } from "effect";

import type { AnyPlugin } from "@executor-js/sdk";
import type { DbProvider } from "./executor-fuma-db";
import { HostConfig } from "./scoped-executor";
import type { PluginsProvider } from "./scoped-executor";
import { requestScopedMiddleware } from "./request-scoped";
import {
  McpServingRoutes,
  McpErrorReporterNoop,
  type McpAuthProvider,
  type McpErrorReporter,
  type McpSessionStore,
} from "@executor-js/host-mcp";

import { composePluginApi } from "../plugin-routes";
import type { ErrorCapture } from "../observability";
import {
  EngineDecoratorNoop,
  type CodeExecutorProvider,
  type EngineDecorator,
} from "./execution-stack";
import {
  makeExecutionStackMiddleware,
  type FailureRenderingStrategy,
} from "./execution-stack-middleware";
import { makeFixedExecutionMiddleware, FixedExecutionProvider } from "./fixed-execution-middleware";
import { IdentityProvider, type IdentityFailure, type Principal } from "./identity";
import {
  makeAccountApiLayer,
  makeProtectedApiLayer,
  toApiHandler,
  type ApiHandler,
} from "./host-foundation";

// A fully-resolved route/app Layer with its channels erased. Used at the
// assembly boundaries (mirrors `toApiHandler`'s loose typing): each host's
// composed set differs (account API present or not, MCP present or not, the
// residual `RDb`/`RAcct` flow varies), but at runtime every requirement is
// provided. Keeping the boundary loose avoids leaking the constrained plugin
// handler-error union into every assembled host layer.
//
// `Layer<in ROut, out E, out RIn>` — `ROut` is CONTRAVARIANT, so `never` (not
// `any`) is the universal supertype in that slot: every concrete route layer is
// assignable to `Layer<never, any, any>`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AppRouteLayer = Layer.Layer<never, any, any>;

// ---------------------------------------------------------------------------
// Provider seams — the variation points the shared core resolves.
// ---------------------------------------------------------------------------

/**
 * The execution engine seams: the code substrate + the optional decorator. The
 * code executor varies per host (QuickJS in-process vs the Cloudflare dynamic
 * worker); the decorator wraps the engine for app-only concerns (cloud's usage
 * metering) and defaults to the no-op when absent.
 *
 * This is the SCOPED execution model: the `ExecutionStackMiddleware` builds a
 * fresh per-(user, org) executor each request via `makeExecutionStack`. Cloud
 * and self-host use it. A host whose executor is a single boot-built instance
 * (local) supplies `providers.fixedExecution` instead — see `AppProviders`.
 */
export interface EngineProviders<REngine = never> {
  /** The code-execution substrate (QuickJS, dynamic worker, …). */
  readonly codeExecutor: Layer.Layer<CodeExecutorProvider>;
  /**
   * Wraps the built engine; defaults to `EngineDecoratorNoop` (no metering). May
   * carry a boot-scoped residual `REngine` (cloud's metering decorator reads the
   * `AutumnService` shell), folded into `RDb` and satisfied by `boot`.
   */
  readonly decorator?: Layer.Layer<EngineDecorator, never, REngine>;
}

/**
 * The MCP serving seams. Omit the whole group to serve no `/mcp` envelope. The
 * reporter defaults to the no-op.
 *
 * `RMcpAuth` is the auth seam's residual requirement (default `never`). The
 * facade ALWAYS provides `providers.identity` to it (a harmless no-op when the
 * seam ignores it), so a host whose MCP auth genuinely reads the neutral
 * identity fallback sets `RMcpAuth = IdentityProvider` (self-host) and one whose
 * MCP plane is a separate credential surface leaves it `never` (cloud).
 */
export interface McpProviders<RMcpAuth = never> {
  /** Resolve a request to an MCP `AuthOutcome` + declare the discovery routes. */
  readonly auth: Layer.Layer<McpAuthProvider, never, RMcpAuth>;
  /** Owns the entire serving-session lifecycle (in-process Map vs DO). */
  readonly sessions: Layer.Layer<McpSessionStore>;
  /** Forward an orchestration defect to the host's capture; default no-op. */
  readonly reporter?: Layer.Layer<McpErrorReporter>;
}

/**
 * The provider seams common to BOTH execution models (scoped + fixed): identity,
 * the optional account API, the optional MCP envelope, and error capture. The
 * execution-specific seams live on the two variant interfaces below.
 */
export interface CommonProviders<RAcct, RIdentity = never, RMcpAuth = never> {
  /**
   * The neutral `IdentityProvider` seam Layer. EVERY host provides the SAME tag:
   * self-host's Better Auth layer, cloud's `workosIdentityLayer`, and local's
   * single-user provider are implementations of one seam. The facade ALWAYS
   * builds the `authenticate` resolver by reading this tag, so a host never
   * hand-writes one.
   *
   * `RIdentity` is the layer's own residual requirement (cloud's per-request
   * `UserStoreService`/`DbService`; `never` for self-host and local). The facade
   * provides this layer PER REQUEST over `requestScoped` (which carries
   * `RIdentity`), so the resolver runs in the request fiber where the identity
   * layer's deps (the postgres socket) live. A `RIdentity = never` layer is
   * provided directly with no per-request dependency.
   */
  readonly identity: Layer.Layer<IdentityProvider, never, RIdentity>;
  /**
   * The account-API middleware Layer (provides `AccountProvider` per request via
   * a `Request<"Requires", AccountProvider>` marker). Omit to serve no account
   * API (self-contained / local). `RAcct` is its residual requirement, satisfied
   * by `boot` / `requestScoped`. The output is left open (`ROut` is
   * contravariant, so `never` accepts any middleware-marker layer).
   */
  readonly account?: Layer.Layer<never, never, RAcct>;
  /** The MCP serving seams; omit to serve no `/mcp` envelope. */
  readonly mcp?: McpProviders<RMcpAuth>;
  /** The `ErrorCapture` seam (console vs Sentry) — the core resolves it. */
  readonly errorCapture: Layer.Layer<ErrorCapture>;
}

/**
 * The SCOPED execution provider seams (cloud + self-host): a per-request
 * executor is built from the resolved `Principal` over the DB handle, the plugin
 * data seams, and the engine substrate. `RDb` is the boot-scoped residual these
 * seams leave (self-host's long-lived `SelfHostDb` handle, cloud's metering
 * decorator's `AutumnService`), satisfied by `boot`.
 */
export interface ScopedExecutionProviders<RDb> {
  /** The `DbProvider` seam (may require `boot`'s long-lived handle). */
  readonly db: Layer.Layer<DbProvider, never, RDb>;
  /**
   * The code-execution engine seams. The optional decorator may carry a
   * boot-scoped residual (cloud's metering decorator's `AutumnService`), folded
   * into `RDb`.
   */
  readonly engine: EngineProviders<RDb>;
  /** The plugin data seams (PluginsProvider + HostConfig). */
  readonly plugins: {
    readonly provider: Layer.Layer<PluginsProvider>;
    readonly config: Layer.Layer<HostConfig>;
  };
  /** Distinct from the fixed shape — never set here. */
  readonly fixedExecution?: undefined;
}

/**
 * The FIXED execution provider seam (local): the host builds ONE executor +
 * engine at boot (single cwd scope + `allowHttp`) and shares it across every
 * request. No per-request scope-stack rebuild, no `DbProvider`/`PluginsProvider`/
 * `HostConfig`/`CodeExecutorProvider` seams (the executor already holds its db,
 * plugins, and code substrate). The facade still runs the identity seam per
 * request to build `AuthContext`, then provides this constant executor/engine.
 */
export interface FixedExecutionProviders {
  /** The boot-built executor + engine + plugin extension map, as one seam. */
  readonly fixedExecution: Layer.Layer<FixedExecutionProvider>;
  /** Distinct from the scoped shape — never set here. */
  readonly db?: undefined;
  readonly engine?: undefined;
  readonly plugins?: undefined;
}

/**
 * Every provider seam, grouped. The execution model is a discriminated union:
 * `ScopedExecutionProviders` (cloud + self-host: per-request scoped executor) or
 * `FixedExecutionProviders` (local: one boot executor). `RAcct` is the account
 * middleware's residual; `RIdentity` the identity seam's own residual; `RMcpAuth`
 * the MCP auth seam's residual.
 */
export type AppProviders<RDb, RAcct, RIdentity = never, RMcpAuth = never> = CommonProviders<
  RAcct,
  RIdentity,
  RMcpAuth
> &
  (ScopedExecutionProviders<RDb> | FixedExecutionProviders);

// ---------------------------------------------------------------------------
// Extensions — app-only surface the core never names.
// ---------------------------------------------------------------------------

/**
 * A route extension Layer: registers on the ambient (un-prefixed) `HttpRouter`.
 * The requirement channel is left open (`RIn` is covariant) because a route
 * handler may carry framework markers — `HttpRouter.HttpRouter` plus, e.g., a
 * `Request<"Error", HttpServerError>` marker from `HttpEffect.fromWebHandler` —
 * that the serve binding clears. Provides nothing of its own.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RouteExtension = Layer.Layer<never, never, any>;

/**
 * App-only HTTP surface mounted alongside the API: each entry registers on the
 * ambient (un-prefixed) `HttpRouter`. Better Auth's `/api/auth/*` handler,
 * Swagger, cloud's marketing + `/autumn` billing route all live here — the
 * shared core never imports them.
 */
export interface AppExtensions {
  /** Extra route Layers to merge into the app router. */
  readonly routes?: ReadonlyArray<RouteExtension>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// The identity seam's failure channel (`Unauthorized | NoOrganization |
// Unavailable`) lives in `./identity` now that BOTH apps provide the neutral
// `IdentityProvider`. The failure strategy renders it: self-host catches it into
// 401/403/503 text (`textFailureStrategy`; it never produces `Unavailable`);
// cloud's strategy renders its exact 401/403/503 `{ error, code }` JSON bytes.
export type { IdentityFailure };

export interface AppConfig<RStrategy, McpExport> {
  /**
   * Serve the typed API under this path prefix ("/api"). make() builds the
   * `router.prefixed(mountPrefix)` view internally; omit to serve at root.
   */
  readonly mountPrefix?: `/${string}`;
  /**
   * How identity-resolution failures render. The facade builds `authenticate`
   * from the `IdentityProvider` tag, so the failure channel is always the shared
   * `IdentityFailure`: cloud renders its `{ error, code }` JSON, self-host 401/403
   * text.
   */
  readonly failure: FailureRenderingStrategy<IdentityFailure, RStrategy>;
  /**
   * Escape hatch for a platform-only export the runtime needs surfaced but the
   * shared core never names (cloud's MCP session Durable Object class). make()
   * passes it back out on the result untouched.
   */
  readonly mcpExport?: McpExport;
}

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

export interface ExecutorAppOptions<
  TPlugins extends readonly AnyPlugin[],
  RDb,
  RAcct,
  RStrategy,
  RBoot,
  RReq,
  McpExport,
  RIdentity = never,
  RMcpAuth = never,
> {
  /** The host's plugin tuple (drives the API + per-request extension Services). */
  readonly plugins: TPlugins;
  /** The provider seams (variation points the core resolves). */
  readonly providers: AppProviders<RDb, RAcct, RIdentity, RMcpAuth>;
  /** App-only surface the core never names (routes). */
  readonly extensions?: AppExtensions;
  /** Mount prefix + failure strategy + the platform-only export escape hatch. */
  readonly config: AppConfig<RStrategy, McpExport>;
  /**
   * The boot-scoped Layer `provideMerge`'d under everything (the long-lived DB
   * handle, the resolved identity, the router config). Satisfies the residual
   * `RDb | RAcct` left by the seams.
   */
  readonly boot: Layer.Layer<RBoot>;
  /** Optional per-request Layer (cloud's request-scoped postgres socket). */
  readonly requestScoped?: Layer.Layer<RReq>;
}

export interface ExecutorApp<TPlugins extends readonly AnyPlugin[], McpExport> {
  /**
   * The composed plugin `HttpApi` value. Reused by the host for Swagger/OpenAPI,
   * `.prefix(...)` spec views, and clients — the SAME spec `make` mounts, so a
   * host's Swagger extension never diverges from the served routes.
   */
  readonly api: ReturnType<typeof composePluginApi<TPlugins>>;
  /**
   * The fully-assembled, platform-agnostic app `Layer` (every route requirement
   * provided). Typed loosely for the same reason `toApiHandler` is — each host's
   * resolved channels differ — but at runtime every requirement is satisfied.
   * The self-host Bun server (`serve.ts`) and cloud Workers both bind this shape.
   */
  readonly appLayer: AppRouteLayer;
  /** Bind `appLayer` to a `fetch`-style web handler (tests + Workers). */
  readonly toWebHandler: () => ApiHandler;
  /** The platform-only export passed through from `config.mcpExport` (cloud's DO class). */
  readonly mcpExport: McpExport;
}

/**
 * Assemble the shared Executor HTTP app from a host's provider seams +
 * extensions. Returns the platform-agnostic `appLayer` (the self-host Bun server
 * + cloud Workers both bind this one shape), a `toWebHandler` binding (tests),
 * and the pass-through `mcpExport`.
 *
 * Internally a faithful reproduction of every host's prior composition root: the
 * execution-stack middleware wrapping the protected API, the MCP envelope's
 * double-provide (build-time auth + per-request seams), the account API on the
 * same prefixed router, the extension routes, and `provideMerge(boot)`.
 */
export const make = <
  const TPlugins extends readonly AnyPlugin[],
  RDb,
  RAcct,
  RStrategy,
  RBoot,
  RReq = never,
  McpExport = undefined,
  RIdentity = never,
  RMcpAuth = never,
>(
  options: ExecutorAppOptions<
    TPlugins,
    RDb,
    RAcct,
    RStrategy,
    RBoot,
    RReq,
    McpExport,
    RIdentity,
    RMcpAuth
  >,
): ExecutorApp<TPlugins, McpExport> => {
  const { plugins, providers, config } = options;

  // The execution model is a discriminated union (see `AppProviders`): a host
  // either supplies the SCOPED seams (db + plugins + engine -> a fresh
  // per-(user, org) executor each request) or a single FIXED executor built once
  // at boot (local). `fixedExecution` present on `providers` selects the latter.
  const fixedExecution = providers.fixedExecution;

  // ---- a `mountPrefix`-prefixed view of the ambient router ---------------
  // Providing it to the API builders makes every API/account route serve under
  // the prefix (the router slices it before matching; no hand-written
  // stripping). Omitted -> the ambient root router is used.
  const prefix = config.mountPrefix;
  const prefixedRouter = prefix
    ? Layer.effect(HttpRouter.HttpRouter)(
        Effect.map(HttpRouter.HttpRouter.asEffect(), (router) => router.prefixed(prefix)),
      )
    : undefined;

  // ---- the OAuth callback path, derived from the SAME `mountPrefix` ------
  // The redirect URI the host serves and registers with providers is
  // `${webBaseUrl}${mountPrefix}/oauth/callback` — the prefix that mounts the
  // API (above) joined with the global `/oauth/callback` route. Deriving it here,
  // the one place `mountPrefix` is known, makes the prefix a single source of
  // truth: a host states it once via `config.mountPrefix` and cannot drift it
  // out of sync with a second hand-written `oauthCallbackPath` (the omission that
  // silently 404'd the redirect on every prefix-mounted host). Injected into the
  // scoped executor's `HostConfig` below; the fixed model (local) sets its own
  // `redirectUri` and is unaffected.
  const oauthCallbackPath = `${prefix ?? ""}/oauth/callback`;

  // ---- (2) the ExecutionStackMiddleware ---------------------------------
  // The identity seam authenticates; the failure strategy renders; the stack
  // Layer + plugin tuple build the per-request executor. The facade ALWAYS builds
  // the resolver by reading the neutral `IdentityProvider` tag — no host hand-
  // writes one. Where the tag is satisfied is the only difference: self-host's
  // identity layer is boot-scoped (in `boot`, captured below), cloud's reads a
  // PER-REQUEST `UserStoreService`, so the facade folds the identity layer over
  // `requestScoped` into this middleware (see `requestScopedIdentity` below) and
  // the tag is resolved in the request fiber. Both fail the shared
  // `Unauthorized | NoOrganization | Unavailable`.
  const authenticate = (
    request: Request,
  ): Effect.Effect<Principal, IdentityFailure, IdentityProvider> =>
    Effect.flatMap(IdentityProvider.asEffect(), (provider) => provider.authenticate(request));

  // The per-request layer combined into the middleware: cloud's `requestScoped`
  // (the postgres socket) with `providers.identity` PROVIDE-MERGEd over it, so the
  // identity layer is rebuilt per request in the same fiber scope as the socket it
  // reads (Cloudflare Workers' I/O isolation) — `RIdentity` (cloud's
  // `UserStoreService`) is satisfied by `requestScoped`, leaving the combined layer
  // residual-free. Self-host omits `requestScoped` -> no per-request layer; its
  // `IdentityProvider` (`RIdentity = never`) is boot-scoped in `boot`.
  // The combined layer provides `IdentityProvider | RReq` and is residual-free in
  // practice: a host that supplies `requestScoped` guarantees its `RReq` covers the
  // identity layer's `RIdentity` (cloud's `RequestScopedServicesLive` provides the
  // `UserStoreService`/`DbService` `workosIdentityLayer` reads). TS cannot reduce
  // `Exclude<RIdentity, RReq>` for abstract params, so widen to the complete shape.
  const requestScopedIdentity = options.requestScoped
    ? (providers.identity.pipe(Layer.provideMerge(options.requestScoped)) as Layer.Layer<
        IdentityProvider | RReq
      >)
    : undefined;

  // The execution middleware, per model. SCOPED: build a fresh per-(user, org)
  // executor each request from the resolved `Principal` over the stack seams.
  // FIXED: resolve the `Principal` (-> `AuthContext`) but provide the single boot
  // executor captured from `boot` (local). Both read the SAME `authenticate`
  // resolver and failure strategy — only the executor lifetime differs.
  //
  // `RCapture` is the boot-scoped context captured ONCE at layer-build time. The
  // per-request `IdentityProvider | RReq` is EXCLUDED so the resolver's identity
  // layer + the stack's per-request deps stay residual, supplied per request by
  // `requestScopedIdentity` folded into the middleware below. Self-host has no
  // `requestScoped`, so its `IdentityProvider` + everything (`RDb | RStrategy`) is
  // captured from `boot` — its prior behavior.
  const executionMiddleware = fixedExecution
    ? makeFixedExecutionMiddleware<
        TPlugins,
        IdentityFailure,
        IdentityProvider,
        RStrategy,
        // Fixed mode has no `requestScoped`: the identity layer + the
        // `FixedExecutionProvider` + the strategy are all boot-scoped (in `boot`),
        // so the whole capture context flows there.
        IdentityProvider | RStrategy | FixedExecutionProvider
      >({
        plugins,
        authenticate,
        strategy: config.failure,
      })
    : makeExecutionStackMiddleware<
        TPlugins,
        IdentityFailure,
        IdentityProvider,
        RDb,
        RStrategy,
        Exclude<IdentityProvider | RDb | RStrategy, IdentityProvider | RReq>
      >({
        plugins,
        authenticate,
        strategy: config.failure,
        // db + plugins.provider + plugins.config + engine.codeExecutor +
        // engine.decorator (default no-op). The merged Layer leaves the
        // boot-scoped `RDb` residual, satisfied by `boot` below. The host's
        // `HostConfig` is decorated with the derived `oauthCallbackPath` so the
        // callback always tracks `mountPrefix`.
        stackLayer: Layer.mergeAll(
          providers.db,
          providers.plugins.provider,
          Layer.effect(HostConfig)(
            Effect.gen(function* () {
              const hostConfig = yield* HostConfig;
              return { ...hostConfig, oauthCallbackPath };
            }),
          ).pipe(Layer.provide(providers.plugins.config)),
          providers.engine.codeExecutor,
          providers.engine.decorator ?? EngineDecoratorNoop,
        ) as Layer.Layer<
          DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider | EngineDecorator,
          never,
          RDb
        >,
      });

  // ---- (3) the protected (plugin) API, wrapped by the middleware ---------
  const protectedApi = makeProtectedApiLayer(plugins, {
    errorCapture: providers.errorCapture,
    router: prefixedRouter,
  });
  // The plugin handler Layers stay late-binding (each requires its plugin's
  // `*ExtensionService` Tag), satisfied by the execution middleware here.
  // Erased to the loose route-layer shape (matching `toApiHandler`): the
  // assembled channels differ per host but every requirement is provided.
  //
  // `requestScopedIdentity` (cloud's per-request postgres socket + the identity
  // layer rebuilt over it) is `.combine`'d INTO the execution middleware so it is
  // rebuilt per HTTP request — `requestScopedMiddleware` runs `Layer.build`
  // inside the per-request fiber's scope (Cloudflare Workers' I/O isolation forbids
  // sharing a socket across requests). Combining drops the resolver's per-request
  // `IdentityProvider` (resolved over the socket) and the stack's `DbService` from
  // the middleware's `requires`. Self-host + local omit `requestScoped` -> the
  // plain middleware `.layer`, whose residual `IdentityProvider` (and, for fixed,
  // `FixedExecutionProvider`) flows to boot-scoped `boot`.
  const middlewareLayer = (
    requestScopedIdentity
      ? executionMiddleware.combine(requestScopedMiddleware(requestScopedIdentity))
      : executionMiddleware
  ).layer as AppRouteLayer;
  const pluginApiLive = protectedApi.layer.pipe(Layer.provide(middlewareLayer)) as AppRouteLayer;

  // ---- (5) the account API (optional) -----------------------------------
  // The account middleware provides `AccountProvider` per request; its residual
  // `RAcct` (cloud's control-plane services; `never` for self-host) flows through
  // to `boot`. Omit `providers.account` -> no account API (the test-stub path).
  const apiLive: AppRouteLayer = providers.account
    ? Layer.merge(
        pluginApiLive,
        makeAccountApiLayer(
          providers.account as Layer.Layer<unknown, never, RAcct>,
          prefixedRouter ? { router: prefixedRouter } : {},
        ) as AppRouteLayer,
      )
    : pluginApiLive;

  // ---- (4) the MCP serving envelope (optional) --------------------------
  // The two providers, by design (mirrors makeSelfHostMcp):
  //   - `Layer.provide(mcpAuth)` satisfies the `HttpRouter.use` callback's
  //     build-time `McpAuthProvider` requirement (it registers a GET per
  //     provider-declared discovery path).
  //   - `HttpRouter.provideRequest(McpSeams)` clears the route handlers'
  //     per-request `Requires` markers (auth + session store + reporter) so the
  //     /mcp routes carry no leftover requirements when merged into the router.
  // The auth seam may require the neutral `IdentityProvider` (`RMcpAuth =
  // IdentityProvider` for self-host, whose MCP auth genuinely reads the fallback;
  // `never` for cloud, whose MCP plane is a separate credential surface). The
  // facade provides the identity seam to mcp.auth either way (a no-op when the
  // seam ignores it). `RIdentity` (cloud's `UserStoreService`) is satisfied by
  // `requestScoped`, so the MCP identity layer is a COMPLETE `Layer<IdentityProvider>`
  // even though cloud's MCP path never invokes it (the socket is never opened).
  const mcpIdentity = (
    options.requestScoped
      ? providers.identity.pipe(Layer.provide(options.requestScoped))
      : providers.identity
  ) as Layer.Layer<IdentityProvider>;
  const mcpRouteLive = providers.mcp ? buildMcpRoutes(providers.mcp, mcpIdentity) : undefined;

  // ---- (6) extension routes (Better Auth handler, Swagger, …) -----------
  const extensionRoutes = options.extensions?.routes ?? [];

  // ---- (7) provideMerge(boot) -> the AppLayer ---------------------------
  // `provideMerge(boot)` resolves the seams' residual requirements (the
  // long-lived DB handle, the control-plane services); the runtime contract is
  // the same — every route requirement is provided.
  const routeLayers: AppRouteLayer[] = [apiLive];
  if (mcpRouteLive) routeLayers.push(mcpRouteLive);
  for (const route of extensionRoutes) routeLayers.push(route);

  const merged = Layer.mergeAll(routeLayers[0], ...routeLayers.slice(1));

  // `requestScoped` is NOT merged into `boot` — that would build the per-request
  // socket ONCE at boot. It is folded into the execution-stack middleware (above)
  // and into the account middleware + extension routes (the host self-combines
  // those) so each rebuilds per request. `boot` is the long-lived context.
  const appLayer: AppRouteLayer = merged.pipe(Layer.provideMerge(options.boot));

  return {
    api: protectedApi.api,
    appLayer,
    // `toApiHandler` takes the (covariant-on-output) loose `Layer<any, …>`; our
    // `AppRouteLayer` uses `never` in the contravariant output slot, so widen.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toWebHandler: () => toApiHandler(appLayer as Layer.Layer<any, any, any>),
    mcpExport: config.mcpExport as McpExport,
  };
};

/**
 * Compose the MCP serving routes over the auth/sessions/reporter seams. The auth
 * seam may require the neutral `IdentityProvider` (`RMcpAuth`); the facade provides
 * the complete identity seam ONCE (memoized) and shares it across the build-time
 * `Layer.provide` AND the per-request `HttpRouter.provideRequest`, so a single
 * identity resolution serves both. When the auth seam ignores identity
 * (`RMcpAuth = never`, cloud), the provide is a harmless no-op.
 */
const buildMcpRoutes = <RMcpAuth>(
  mcp: McpProviders<RMcpAuth>,
  identity: Layer.Layer<IdentityProvider>,
): Layer.Layer<never, never, HttpRouter.HttpRouter> => {
  // The auth seam may declare `IdentityProvider` as a requirement (self-host's
  // genuinely reads it; cloud's ignores it — its MCP JWT/api-key path is separate).
  // Either way the identity seam is provided ONCE (memoized) and shared across the
  // build-time provide + the per-request `provideRequest`. The provided
  // `IdentityProvider` covers `RMcpAuth` whether it is `IdentityProvider` or `never`.
  const mcpAuthLive = (mcp.auth as Layer.Layer<McpAuthProvider, never, IdentityProvider>).pipe(
    Layer.provide(identity),
  );
  const mcpSeams = Layer.mergeAll(mcpAuthLive, mcp.sessions, mcp.reporter ?? McpErrorReporterNoop);
  return McpServingRoutes.pipe(HttpRouter.provideRequest(mcpSeams), Layer.provide(mcpAuthLive));
};

// Re-exported so a strategy author building the `config.failure` value can name
// the `Principal` the strategy renders failures around.
export type { Principal };
