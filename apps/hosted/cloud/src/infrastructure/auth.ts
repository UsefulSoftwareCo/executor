import { BrowserSession } from "@executor-js/hosted-server/browser/contracts";
import { HostedAppSessions } from "@executor-js/hosted-server/app-ui";
import { authObservability } from "../implementation/auth-observability.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { APIError } from "better-auth/api";
import { OrganizationId } from "@executor-js/hosted-server";
import { BillingMeter } from "../contracts/billing-meter.ts";
import { billingLive } from "../implementation/billing.ts";
import {
  clearSiteVisitorOnSignOut,
  recordCloudSignup,
  recordCloudLogin,
} from "../implementation/product-analytics.ts";
import { cloudAuthOptions, cloudAuthSettings } from "../implementation/auth-options.ts";
import { Onboarding } from "../contracts/onboarding.ts";
/** Native Alchemy auth binding for the HTTP Worker; MCP session objects use `mcp-auth.ts`. */
import {
  CurrentUsage,
  CurrentUserId,
  recordUsage,
  usageFailure,
  Authentication,
  AuthenticationUnavailable,
  sessionPrincipal,
  lookupMembership,
  deleteOrganizationRecords,
  lookupOrganizationSlug,
  resolveOrganizationReference,
  ApiAuthentication,
  apiBearerAccess,
  grantExpiry,
  authEndpointTemplates,
} from "@executor-js/hosted-server";
import { routeTemplates } from "@executor-js/telemetry";
import { betterAuth } from "better-auth";
import { BetterAuthApiError, isAPIErrorLike } from "@alchemy.run/better-auth";
import { cloudSessionCookiePrefix } from "../contracts/browser.ts";
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Context, Effect, Layer, Option, Redacted, Schema, type Scope } from "effect";
import { HttpBody, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { SendAuthEmail } from "../contracts/email.ts";
import { cloudSecrets } from "./secrets.ts";
import { cloudAuthRateLimit } from "./stage.ts";
import { AuthDatabase, appSessionsPerCall, boundAuthAdapter } from "./auth-database.ts";
import { invocationSql } from "./invocation-database.ts";
import { mcpAuthentication } from "./mcp-auth.ts";

/** Bind during initialization; database calls capture the current invocation only. */
export const cloudAuth = (send: SendAuthEmail, onboarding: typeof Onboarding.Service) =>
  Effect.gen(function* () {
    // Only `alchemy dev` binds the switch; see `authRateLimitSwitchBindings`.
    const environment = yield* Cloudflare.WorkerEnvironment;
    const settings = {
      ...(yield* cloudAuthSettings.pipe(Effect.orDie)),
      rateLimitEnabled: yield* cloudAuthRateLimit(environment.AUTH_RATE_LIMIT_SWITCH === true).pipe(
        Effect.orDie,
      ),
    };
    const secrets = yield* cloudSecrets.pipe(Effect.orDie);
    const meter = yield* BillingMeter.pipe(Effect.provide(yield* billingLive));
    // Better Auth invokes Promise callbacks. Carry the calling request's scope,
    // bindings and cancellation through that boundary, isolated per invocation.
    const callbacks = new AsyncLocalStorage<{
      readonly context: Context.Context<
        RuntimeContext | HttpServerRequest.HttpServerRequest | Scope.Scope
      >;
      readonly signal: AbortSignal;
    }>();
    const runCallback = <A, E>(
      effect: Effect.Effect<A, E, HttpServerRequest.HttpServerRequest>,
    ) => {
      const current = callbacks.getStore();
      if (current === undefined)
        return Promise.reject(
          new APIError("SERVICE_UNAVAILABLE", {
            message: "Auth callbacks are unavailable outside an auth request.",
          }),
        );
      return Effect.runPromise(effect.pipe(Effect.provideContext(current.context)), {
        signal: current.signal,
      });
    };
    const observation = authObservability();
    const options = cloudAuthOptions(
      settings,
      ["cf-connecting-ip"],
      send,
      {
        memberLimit: (id) =>
          runCallback(
            Schema.decodeUnknownEffect(OrganizationId)(id).pipe(
              Effect.flatMap(meter.memberLimit),
              Effect.mapError(
                () =>
                  new APIError("SERVICE_UNAVAILABLE", {
                    message: "We could not check your member allowance. Try again.",
                  }),
              ),
              Effect.scoped,
            ),
          ),
      },
      (userId) => runCallback(recordCloudSignup(userId)),
      (userId) => {
        observation.sessionCreated();
        return runCallback(recordCloudLogin(userId));
      },
      (usage) =>
        runCallback(
          recordUsage("product_operation_completed", {
            area: "auth",
            operation: usage.operation,
            status_code: usage.status,
            ok: usage.status < 400,
            outcome: usage.status < 400 ? "success" : "failure",
          }).pipe(
            Effect.provideService(CurrentUserId, usage.userId),
            Effect.provideService(CurrentUsage, { source: "dashboard" }),
          ),
        ),
      // Fails closed: an unanswered v1 check refuses the create instead of allowing it.
      (userId) =>
        runCallback(
          onboarding.allowsOrganization(userId).pipe(
            Effect.mapError(
              () =>
                new APIError("SERVICE_UNAVAILABLE", {
                  message: "We could not check your account. Try again.",
                }),
            ),
          ),
        ),
      observation.refreshRejected,
    );
    const database = yield* AuthDatabase;
    const makeInstance = (secret: string) =>
      betterAuth({
        ...options,
        plugins: [...options.plugins, observation.plugin],
        database: database.options,
        secret,
        // Cookies use hostnames, not ports; cloud dev must not replace self-host sessions.
        advanced: {
          ...options.advanced,
          cookiePrefix: cloudSessionCookiePrefix(settings.url),
          // The deployment migration validates the schema; runtime reads skip introspection.
          database: { ...options.advanced.database, validateSchema: false },
          backgroundTasks: { handler: database.background },
        },
      });
    // One Better Auth instance per isolate, like a long-running server's. Its options,
    // plugins and endpoints hold no request state: request context travels through
    // `callbacks`, and every call binds its own invocation's pool through `database`.
    // The signing secret is deployment configuration, read in the first invocation.
    let instance: ReturnType<typeof makeInstance> | undefined;
    let routes: ReturnType<typeof routeTemplates> | undefined;
    const native = secrets.authSecret.pipe(
      Effect.map((secret) => (instance ??= makeInstance(Redacted.value(secret)))),
    );
    // Better Auth work runs as Promise code on this invocation's pool, bound to the
    // calling span so each auth SQL timing span is a child of the operation that issued it.
    const bound = Effect.all([native, database.bind]).pipe(Effect.provide(RuntimeContext.phantom));
    const nativeCall = <A>(call: (instance: ReturnType<typeof makeInstance>) => Promise<A>) =>
      bound.pipe(
        Effect.flatMap(([instance, bind]) =>
          Effect.tryPromise({ try: () => bind(() => call(instance)), catch: (error) => error }),
        ),
        Effect.catch((error) =>
          isAPIErrorLike(error)
            ? Effect.fail(BetterAuthApiError.fromAPIError(error))
            : Effect.die(error),
        ),
      );
    const authContext = Effect.flatMap(native, (instance) =>
      Effect.promise(() => instance.$context),
    );
    const adapter = Effect.all([authContext, database.bind]).pipe(
      Effect.map(([context, bind]) => boundAuthAdapter(context.adapter, bind)),
      Effect.provide(RuntimeContext.phantom),
    );
    // Bearer authentication reads its rows in one statement on the client this invocation
    // shares with Better Auth and the executor.
    const withSql = yield* invocationSql;
    const identity = Layer.effect(
      Authentication,
      Effect.gen(function* () {
        // Built inside fetch: database work stays in the current invocation's scope.
        return Authentication.of({
          origin: settings.url,
          resourceOrigins: settings.resourceOrigins,
          oauthRedirectUri: Option.getOrUndefined(settings.oauthRedirectUri),
          current: (headers) =>
            nativeCall((instance) =>
              instance.api.getSession({
                headers,
                query: { disableRefresh: true, disableCookieCache: true },
              }),
            )
              .pipe(
                Effect.tapCause((cause) =>
                  Effect.annotateCurrentSpan({
                    "auth.failure.type": usageFailure(cause).error_type ?? "Interrupted",
                  }),
                ),
                Effect.mapError(() => new AuthenticationUnavailable()),
                Effect.flatMap(sessionPrincipal),
              )
              .pipe(Effect.withSpan("auth.current")),
          organization: (reference) =>
            adapter
              .pipe(Effect.flatMap((adapter) => resolveOrganizationReference(adapter, reference)))
              .pipe(Effect.withSpan("auth.organization")),
          organizationSlug: (headers, organizationId) =>
            bound
              .pipe(
                Effect.flatMap(([instance, bind]) =>
                  lookupOrganizationSlug(() =>
                    bind(() =>
                      instance.api.getOrganization({ headers, query: { organizationId } }),
                    ),
                  ),
                ),
              )
              .pipe(Effect.withSpan("auth.organizationSlug")),
          membership: (principal, organizationId) =>
            adapter
              .pipe(
                Effect.flatMap((adapter) => lookupMembership(adapter, principal, organizationId)),
              )
              .pipe(Effect.withSpan("auth.membership")),
          removeOrganization: (organizationId) =>
            adapter
              .pipe(Effect.flatMap((adapter) => deleteOrganizationRecords(adapter, organizationId)))
              .pipe(Effect.withSpan("auth.removeOrganization")),
        });
      }),
    );
    const origins = {
      origin: settings.url,
      resourceOrigins: settings.resourceOrigins,
      issuer: settings.issuer,
    };
    const mcpIdentity = mcpAuthentication(origins, bound, withSql);
    const apiIdentity = Layer.effect(
      ApiAuthentication,
      Effect.gen(function* () {
        return ApiAuthentication.of({
          ...origins,
          authenticate: (headers, organization) =>
            withSql(apiBearerAccess(origins, { headers, organization })).pipe(
              Effect.tap(({ access }) =>
                Effect.annotateCurrentSpan("executor.organization.id", access.organization),
              ),
              Effect.withSpan("auth.authenticate"),
            ),
        });
      }),
    );
    const appSessions = Layer.succeed(
      HostedAppSessions,
      appSessionsPerCall(
        Effect.all([authContext, database.bind]).pipe(
          Effect.map(([context, bind]) => ({
            internalAdapter: boundAuthAdapter(context.internalAdapter, bind),
            adapter: boundAuthAdapter(context.adapter, bind),
          })),
        ),
      ),
    );
    const requestHandler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
      const [instance, bind] = yield* bound;
      routes ??= routeTemplates(authEndpointTemplates(instance.api));
      yield* routes.record(new URL(web.url).pathname);
      const context = yield* Effect.context<
        RuntimeContext | HttpServerRequest.HttpServerRequest | Scope.Scope
      >();
      // Better Auth returns API errors as responses; it rejects only on defects.
      const response = yield* Effect.promise((signal) =>
        callbacks.run({ context, signal }, () => bind(() => instance.handler(web))),
      );
      if (response.body === null) return HttpServerResponse.fromWeb(response);
      // Better Auth answers with complete JSON. Sent as a stream, its last byte would wait for
      // the request's cleanup, including Better Auth queries the request left running.
      const body = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()));
      return HttpServerResponse.setBody(
        HttpServerResponse.fromWeb(response),
        HttpBody.uint8Array(body, response.headers.get("content-type") ?? undefined),
      );
    });
    const handler = observation
      .observe(requestHandler)
      .pipe(
        Effect.flatMap(
          clearSiteVisitorOnSignOut(Option.getOrUndefined(settings.hosts.sharedCookieDomain)),
        ),
        Effect.map(HttpServerResponse.setHeader("cache-control", "no-store")),
      );
    return {
      browserSession: (headers: Headers) =>
        nativeCall((instance) =>
          instance.api.getSession({
            headers,
            query: { disableRefresh: true, disableCookieCache: true },
          }),
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(BrowserSession)),
          Effect.mapError(() => new AuthenticationUnavailable()),
        ),
      identity,
      mcpIdentity,
      apiIdentity,
      appSessions,
      // Background jobs only: grant expiry runs from the data step and the daily cron.
      agentGrants: grantExpiry((run) => nativeCall((instance) => run(instance.api))),
      handler,
      origin: settings.url,
      resourceOrigins: settings.resourceOrigins,
      hosts: settings.hosts,
      cookiePrefix: cloudSessionCookiePrefix(settings.url),
    };
  });
