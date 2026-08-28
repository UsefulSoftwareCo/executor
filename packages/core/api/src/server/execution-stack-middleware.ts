// ---------------------------------------------------------------------------
// Shared executor-API ExecutionStackMiddleware.
//
// Cloud and self-host had a structurally identical `HttpRouter` middleware that,
// per request:
//   1. reads the inbound `HttpServerRequest`, converts it to a web `Request`,
//   2. resolves identity (api-key/session for cloud, cookie/bearer/x-api-key for
//      self-host) into a neutral `Principal`,
//   3. builds the per-(user, org) executor + engine via `makeExecutionStack`,
//   4. provides `AuthContext` + the execution-stack services + every plugin
//      extension Service to the wrapped handler.
//
// This factory owns that common body. The differences are injected:
//   - `authenticate`     — the provider's resolve fn. BOTH apps yield the neutral
//                          `Principal` and fail the SHARED `Unauthorized |
//                          NoOrganization | Unavailable` (cloud: WorkOS api-key/
//                          sealed-session; self-host: Better Auth cookie/bearer/
//                          x-api-key). The credential precedence stays INSIDE each
//                          impl.
//   - `renderFailure`    — the failure-rendering strategy. Cloud renders the
//                          shared errors as its exact `{ error, code }` JSON at
//                          401/403/503; self-host catches them into 401/403/503
//                          text. The seam (request -> Principal | shared error) is
//                          identical; only the rendering differs.
//   - `plugins`          — the host's plugin tuple (typed extension Services).
//   - `stackLayer`       — the host's `makeExecutionStack` seam Layer (cloud:
//                          `CloudMeteredExecutionStackLayer`; self-host:
//                          `SelfHostExecutionStackLayer`).
//
// `LongLived` is the boot-scoped context captured at layer-build time (the
// provider tag + the stack's long-lived deps) so the per-request function only
// depends on `HttpRouter`-provided context. The returned value is the
// `HttpRouter.middleware` (NOT `.layer`) so a host can still `.combine(...)` a
// request-scoped middleware into it (cloud folds its per-request DB layer).
// ---------------------------------------------------------------------------

import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Context, Data, Effect, Layer } from "effect";
import type * as Cause from "effect/Cause";

import type { AnyPlugin } from "@executor-js/sdk";
import type { ExecutionEngine } from "@executor-js/execution";

import type { DbProvider } from "./executor-fuma-db";
import {
  RequestOrgSlug,
  RequestWebOrigin,
  type HostConfig,
  type PluginsProvider,
} from "./scoped-executor";
import { ExecutionEngineService, ExecutorService } from "../services";
import { providePluginExtensions, type PluginExtensionServices } from "../plugin-routes";
import {
  authContextFromPlatform,
  authContextFromPrincipal,
  AuthContext,
  isPlatformPrincipal,
  ReadOnlyCredential,
  type IdentityFailure,
  type ResolvedPrincipal,
} from "./identity";
import {
  makeExecutionStack,
  makePlatformExecutionStack,
  type CodeExecutorProvider,
  type EngineDecorator,
} from "./execution-stack";

/**
 * A failure-rendering strategy. `renderFailure` runs on the result of
 * `authenticate`: it MUST either re-raise the failure (so a `Respondable` typed
 * error reaches the framework's response pipeline — cloud) or recover it into a
 * concrete `HttpServerResponse` (self-host's explicit 401/403 text). `RR` is the
 * residual requirement the strategy adds (always `never` in practice).
 */
export interface FailureRenderingStrategy<E, RR = never> {
  readonly renderFailure: <A extends ResolvedPrincipal, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A | HttpServerResponse.HttpServerResponse, E, R | RR>;
}

/**
 * Self-host's strategy: this is an `HttpRouter` middleware (not an `HttpApi`
 * endpoint), so a failed typed error would surface as a 500 — recover
 * `Unauthorized` -> 401 text and `NoOrganization` -> 403 text instead. Self-host
 * never produces `Unavailable`, but the shared channel now includes it, so it is
 * recovered to a 503 text for total coverage.
 */
export const textFailureStrategy: FailureRenderingStrategy<IdentityFailure> = {
  renderFailure: (effect) =>
    effect.pipe(
      Effect.catchTags({
        Unauthorized: () =>
          Effect.succeed(HttpServerResponse.text("Unauthorized", { status: 401 })),
        NoOrganization: () =>
          Effect.succeed(
            HttpServerResponse.text("No organization for this account", {
              status: 403,
            }),
          ),
        Unavailable: () =>
          Effect.succeed(
            HttpServerResponse.text("Authentication temporarily unavailable", {
              status: 503,
            }),
          ),
        // Self-host/local identity never resolves a platform credential, but the
        // method gate raises this tag on the SHARED channel, so total coverage
        // requires rendering it (and keeps the strategy honest if that changes).
        ReadOnlyCredential: () =>
          Effect.succeed(
            HttpServerResponse.text("Organization API keys are read-only", {
              status: 403,
            }),
          ),
      }),
    ),
};

export interface MakeExecutionStackMiddlewareOptions<
  TPlugins extends readonly AnyPlugin[],
  E,
  RLong,
  RStack,
  RStrategy,
> {
  /** The host's plugin tuple — drives the typed extension Services and binding. */
  readonly plugins: TPlugins;
  /**
   * Resolve the inbound web `Request` to a neutral `Principal` — or, for an
   * org-level credential (cloud's org-scoped API key), a `PlatformPrincipal`
   * that the middleware routes to the read-only platform branch.
   * Adapter-specific credential precedence stays inside this function.
   */
  readonly authenticate: (request: Request) => Effect.Effect<ResolvedPrincipal, E, RLong>;
  /** Render `authenticate` failures (passthrough for cloud, text for self-host). */
  readonly strategy: FailureRenderingStrategy<E | ReadOnlyCredential, RStrategy>;
  /** The host's `makeExecutionStack` seam Layer. */
  readonly stackLayer: Layer.Layer<
    DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider | EngineDecorator,
    never,
    RStack
  >;
}

/**
 * Build the shared `ExecutionStackMiddleware`. `RCapture` is the boot-scoped
 * context captured ONCE at layer-build time; anything the per-request body still
 * needs (`RLong | RStack | RStrategy` minus `RCapture`) stays a residual
 * requirement of the returned middleware, satisfied per request by the host.
 *
 *   - self-host captures everything (`AuthProvider | SelfHostDb`): no residual,
 *     so `.layer` is a complete Layer.
 *   - cloud captures only the boot-scoped services (its identity provider + the
 *     app-only billing service its metered stack reads) and leaves `DbService`
 *     residual, satisfied per request by `.combine(requestScopedMiddleware(rsLive))`
 *     (so the postgres.js socket lives in the request fiber's scope).
 *
 * The returned value is the `HttpRouter.middleware` (NOT `.layer`) so cloud can
 * still `.combine(...)`.
 */
export const makeExecutionStackMiddleware = <
  const TPlugins extends readonly AnyPlugin[],
  E,
  RLong = never,
  RStack = never,
  RStrategy = never,
  RCapture = RLong | RStack | RStrategy,
>(
  options: MakeExecutionStackMiddlewareOptions<TPlugins, E, RLong, RStack, RStrategy>,
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
      return (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const webRequest = yield* HttpServerRequest.toWeb(request);
          const resolved = yield* options.strategy.renderFailure(
            options.authenticate(webRequest).pipe(
              // The PLATFORM branch's gate lives here, before any handler: an
              // org credential is read-only by construction, so anything that
              // is not a safe read is refused as a typed 403 rather than
              // reaching a handler that would bind it to a subject or attempt
              // a write (the storage policy would refuse the write anyway —
              // this makes the refusal a clear response instead of a 500).
              Effect.filterOrFail(
                (principal) =>
                  !isPlatformPrincipal(principal) ||
                  isPlatformSafeRequest(webRequest.method, new URL(webRequest.url).pathname),
                () =>
                  new ReadOnlyCredential({
                    code: "read_only_credential",
                    message: "Organization API keys are read-only",
                  }),
              ),
            ),
          );
          // The strategy recovered the failure into a Response — return it.
          if (!isPrincipal(resolved)) return resolved;

          if (isPlatformPrincipal(resolved)) {
            // Org credential: the subject-less, write-refusing platform stack.
            // No `touchSubject` runs, so the credential never mints a phantom
            // user row in the very lists the admin plane serves. Neither
            // `RequestWebOrigin` nor `RequestOrgSlug` is provided: both feed
            // browser-handoff URL construction, which only interactive member
            // flows perform, and `makePlatformExecutor` reads neither.
            const { executor } = yield* makePlatformExecutionStack<TPlugins>(
              resolved.organizationId,
            ).pipe(
              Effect.provide(options.stackLayer),
              Effect.withSpan("executor.stack.http.resolve_platform"),
            );
            return yield* httpEffect.pipe(
              Effect.provideService(AuthContext, AuthContext.of(authContextFromPlatform(resolved))),
              Effect.provideService(ExecutorService, executor),
              // The engine runs code as an acting member; the platform view has
              // none, and owns no executions. GET readers get the honest empty
              // answers; the execute/resume paths sit behind the method gate
              // above and are unreachable.
              Effect.provideService(ExecutionEngineService, readOnlyExecutionEngine),
              provideExecutorExtensions(executor),
            );
          }
          const auth = AuthContext.of(authContextFromPrincipal(resolved));
          // The public origin the caller actually hit, so a host with no static
          // web base URL (a Worker) derives one zero-config. An explicit
          // `HostConfig.webBaseUrl` still wins; we deliberately read `request.url`
          // (not a spoofable `X-Forwarded-Host`).
          const stack = makeExecutionStack<TPlugins>(
            resolved.accountId,
            resolved.organizationId,
            resolved.organizationName,
            // A plain member binds with workspace writes denied; an admin —
            // or a host with no role model (`orgRole` absent) — binds allowed.
            { orgWrites: resolved.orgRole === "member" ? "denied" : "allowed" },
          ).pipe(
            Effect.provide(options.stackLayer),
            Effect.provideService(RequestWebOrigin, {
              origin: requestWebOriginFromRequest(webRequest),
            }),
          );
          // Pin browser-handoff URLs to the resolved org's slug when the identity
          // provider carried one. Absent slug -> the service stays unprovided and
          // the URL falls back to its bare, client-canonicalized form.
          const { executor, engine } = yield* resolved.organizationSlug !== undefined
            ? stack.pipe(
                Effect.provideService(RequestOrgSlug, { slug: resolved.organizationSlug }),
                Effect.withSpan("executor.stack.http.resolve"),
              )
            : stack.pipe(Effect.withSpan("executor.stack.http.resolve"));
          return yield* httpEffect.pipe(
            Effect.provideService(AuthContext, auth),
            Effect.provideService(ExecutorService, executor),
            Effect.provideService(ExecutionEngineService, engine),
            provideExecutorExtensions(executor),
          );
          // Provide the boot-captured context; uncaptured deps (cloud's
          // request-scoped `DbService`) remain residual and flow through here.
        }).pipe(Effect.provideContext(captured as Context.Context<RCapture>));
    }),
  );
};

// `renderFailure` yields either the resolved principal (proceed) or an
// already-built `HttpServerResponse` (the strategy recovered the failure).
// Discern by the marker the response framework brands its values with.
const isPrincipal = (
  value: ResolvedPrincipal | HttpServerResponse.HttpServerResponse,
): value is ResolvedPrincipal => !HttpServerResponse.isHttpServerResponse(value);

/**
 * Whether a request is a SAFE READ the platform branch may serve. The method
 * check (GET, plus HEAD — the router serves HEAD off the GET route) is
 * necessary but NOT sufficient: `GET /oauth/callback` is the one core GET with
 * side effects — completing it reads an org-owned oauth session, performs an
 * outbound authorization-code exchange with the org's client credentials, and
 * then attempts the connection write. A read-only credential must be refused
 * BEFORE that exchange burns the in-flight code, not after the storage policy
 * rejects the final write, so the callback path is excluded by name. It is a
 * browser-redirect surface — no legitimate machine-credential caller lands on
 * it with a Bearer header.
 */
const isPlatformSafeRequest = (method: string, pathname: string): boolean =>
  (method === "GET" || method === "HEAD") && !pathname.endsWith("/oauth/callback");

/** Reaching an engine member the platform branch cannot honestly serve is a
 *  wiring bug (the safe-request gate keeps those paths unreachable), so it
 *  dies as a tagged defect rather than failing with a typed error a client
 *  could mistake for a product answer. */
class PlatformEngineUnavailable extends Data.TaggedError("PlatformEngineUnavailable")<{
  readonly member: string;
}> {}

/**
 * The engine the platform branch provides. The one member a safe read can
 * actually reach — `getPausedExecution`, via `GET /executions/:id` — answers
 * null (a 404), honestly: the platform view owns no executions. The paused
 * counters answer the same empty story for any future reader. Everything else
 * (execute, resume, the MCP tool description) exists to satisfy the service
 * shape, sits behind the middleware's safe-request gate, and dies if reached.
 */
const readOnlyExecutionEngine: ExecutionEngine<Cause.YieldableError> = {
  // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: unreachable behind the middleware's safe-request gate; reaching it is a wiring bug, not a typed product outcome
  execute: () => Effect.die(new PlatformEngineUnavailable({ member: "execute" })),
  // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: unreachable behind the middleware's safe-request gate; reaching it is a wiring bug, not a typed product outcome
  executeWithPause: () => Effect.die(new PlatformEngineUnavailable({ member: "executeWithPause" })),
  // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: unreachable behind the middleware's safe-request gate; reaching it is a wiring bug, not a typed product outcome
  resume: () => Effect.die(new PlatformEngineUnavailable({ member: "resume" })),
  getPausedExecution: () => Effect.succeed(null),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: only the MCP tool server reads this, and the MCP plane never serves a platform credential
  getDescription: Effect.die(new PlatformEngineUnavailable({ member: "getDescription" })),
};

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const parseOrigin = (value: string): URL | null => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: new URL() throws on malformed origin; no Effect equivalent for this sync parse
  try {
    const parsed = new URL(value);
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed;
  } catch {
    return null;
  }
};

const isLoopbackOrigin = (value: URL): boolean => LOOPBACK_HOSTNAMES.has(value.hostname);

const originString = (value: URL): string => value.origin;

export const requestWebOriginFromRequest = (request: Request): string => {
  const requestUrl = new URL(request.url);
  const requestOrigin = requestUrl.origin;
  const browserOriginHeader = request.headers.get("origin");
  if (!browserOriginHeader) return requestOrigin;

  const browserOrigin = parseOrigin(browserOriginHeader);
  if (!browserOrigin) return requestOrigin;
  if (!isLoopbackOrigin(requestUrl) || !isLoopbackOrigin(browserOrigin)) return requestOrigin;
  if (requestUrl.protocol !== browserOrigin.protocol) return requestOrigin;
  if (requestUrl.port !== browserOrigin.port) return requestOrigin;
  return originString(browserOrigin);
};
