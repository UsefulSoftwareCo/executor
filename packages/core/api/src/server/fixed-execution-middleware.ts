// ---------------------------------------------------------------------------
// Fixed-executor ExecutionStackMiddleware — the single-scope, boot-built
// execution variant of `./execution-stack-middleware.ts`.
//
// The per-request `ExecutionStackMiddleware` resolves a `Principal` and then
// builds a FRESH per-(user, org) executor each request via `makeExecutionStack`
// -> `makeScopedExecutor`, binding `{ tenant: organizationId, subject:
// accountId }`. That is the cloud / self-host model: a per-request executor
// derived from identity.
//
// Local is structurally different: ONE executor is built once at boot over a
// SINGLE tenant derived from the working directory, with
// `oauthEndpointUrlPolicy: { allowHttp: true }`, and shared across every request
// (and the in-process MCP). There is no per-request (user, org) binding. Forcing
// local through the scoped middleware would (a) swap its cwd tenant for a
// synthetic identity-derived one — orphaning existing `~/.executor` data — and
// (b) silently drop `allowHttp`.
//
// So a host whose execution is a single boot executor supplies a
// `FixedExecutionProvider` (the pre-built executor + engine) and this middleware
// resolves identity to `AuthContext` exactly like the scoped variant, then
// provides the FIXED executor + engine + plugin extension Services to the
// handler — no per-request rebuild. The identity seam still runs (so a host can
// gate or attribute requests), but the executor is constant. This is local's
// genuine model expressed as a first-class `make()` execution mode, not a
// special case bolted onto the scoped path.
// ---------------------------------------------------------------------------

import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Context, Effect } from "effect";
import type * as Cause from "effect/Cause";

import type { AnyPlugin, Executor, PluginExtensions } from "@executor-js/sdk";
import type { ExecutionEngine } from "@executor-js/execution";

import { ExecutionEngineService, ExecutorService } from "../services";
import { providePluginExtensions, type PluginExtensionServices } from "../plugin-routes";
import { authContextFromPrincipal, AuthContext, type Principal } from "./identity";
import type { FailureRenderingStrategy } from "./execution-stack-middleware";

/**
 * The pre-built, boot-scoped execution a fixed-executor host serves on. Local
 * builds this ONCE (single cwd scope + `allowHttp`) and shares it across every
 * request and the in-process MCP. `extensions` is the plugin extension map
 * (`executor[pluginId]`) the handlers' `*ExtensionService` Tags read.
 */
export interface FixedExecution<TPlugins extends readonly AnyPlugin[] = readonly AnyPlugin[]> {
  readonly executor: Executor<TPlugins>;
  readonly engine: ExecutionEngine<Cause.YieldableError>;
  readonly extensions: PluginExtensions<TPlugins>;
}

export class FixedExecutionProvider extends Context.Service<
  FixedExecutionProvider,
  FixedExecution
>()("@executor-js/api/FixedExecutionProvider") {}

export interface MakeFixedExecutionMiddlewareOptions<
  TPlugins extends readonly AnyPlugin[],
  E,
  RLong,
  RStrategy,
> {
  /** The host's plugin tuple — drives the typed extension Services and binding. */
  readonly plugins: TPlugins;
  /**
   * Resolve the inbound web `Request` to a neutral `Principal`. The credential
   * shape stays inside this function; local's single-user provider always
   * resolves the one local Principal.
   */
  readonly authenticate: (request: Request) => Effect.Effect<Principal, E, RLong>;
  /** Render `authenticate` failures (text for local, matching self-host). */
  readonly strategy: FailureRenderingStrategy<E, RStrategy>;
}

/**
 * Build the fixed-executor `ExecutionStackMiddleware`. Per request: resolve the
 * `Principal` (and render any failure), build the `AuthContext`, then provide
 * the boot-built `FixedExecutionProvider`'s executor + engine + plugin extension
 * Services to the wrapped handler. `RCapture` is the boot-scoped context
 * captured once at layer-build time (the identity provider + the fixed execution
 * seam); the per-request body depends only on `HttpRouter`-provided context.
 *
 * Returned as the `HttpRouter.middleware` value (NOT `.layer`) so it composes
 * the same way the scoped variant does.
 */
export const makeFixedExecutionMiddleware = <
  const TPlugins extends readonly AnyPlugin[],
  E,
  RLong = never,
  RStrategy = never,
  RCapture = RLong | RStrategy | FixedExecutionProvider,
>(
  options: MakeFixedExecutionMiddlewareOptions<TPlugins, E, RLong, RStrategy>,
) => {
  const provideExecutorExtensions = providePluginExtensions(options.plugins);
  return HttpRouter.middleware<{
    provides:
      | AuthContext
      | ExecutorService
      | ExecutionEngineService
      | PluginExtensionServices<TPlugins>;
  }>()(
    Effect.gen(function* () {
      const captured = yield* Effect.context<RCapture>();
      const { executor, engine, extensions } = yield* FixedExecutionProvider.asEffect();
      return (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const webRequest = yield* HttpServerRequest.toWeb(request);
          const resolved = yield* options.strategy.renderFailure(options.authenticate(webRequest));
          // The strategy recovered the failure into a Response — return it.
          if (!isPrincipal(resolved)) return resolved;
          const auth = AuthContext.of(authContextFromPrincipal(resolved));
          return yield* httpEffect.pipe(
            Effect.provideService(AuthContext, auth),
            Effect.provideService(ExecutorService, executor),
            Effect.provideService(ExecutionEngineService, engine),
            provideExecutorExtensions(extensions as PluginExtensions<TPlugins>),
          );
        }).pipe(Effect.provideContext(captured as Context.Context<RCapture>));
    }),
  );
};

// `renderFailure` yields either the resolved `Principal` (proceed) or an
// already-built `HttpServerResponse` (the strategy recovered the failure).
const isPrincipal = (
  value: Principal | HttpServerResponse.HttpServerResponse,
): value is Principal => !HttpServerResponse.isHttpServerResponse(value);
