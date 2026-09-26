import { BrowserSession } from "@executor-js/hosted-server/browser/contracts";
import { HostedAppSessions, hostedAppSessions } from "@executor-js/hosted-server/app-ui";
import { authObservability } from "../implementation/auth-observability.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { APIError } from "better-auth/api";
import { OrganizationId } from "@executor-js/hosted-server";
import { BillingMeter } from "../contracts/billing-meter.ts";
import { billingLive } from "../implementation/billing.ts";
import { clearHeroIdentityOnSignOut } from "../implementation/hero-experiment.ts";
import { recordCloudSignup, recordCloudLogin } from "../implementation/product-analytics.ts";
import { cloudAuthOptions, cloudAuthSettings } from "../implementation/auth-options.ts";
/** Native Alchemy auth binding, shared by the HTTP Worker and MCP session objects. */
import {
  CurrentUsage,
  CurrentUserId,
  recordUsage,
  usageFailure,
  Authentication,
  AuthenticationUnavailable,
  McpAuthentication,
  sessionPrincipal,
  lookupMembership,
  deleteOrganizationRecords,
  lookupOrganizationSlug,
  resolveOrganizationReference,
  mcpAuthenticationError,
  ApiAuthentication,
  apiAuthenticationError,
} from "@executor-js/hosted-server";
import { BetterAuth, BetterAuthApiError, isAPIErrorLike } from "@alchemy.run/better-auth";
import { cloudSessionCookiePrefix } from "../contracts/browser.ts";
import { RuntimeContext } from "alchemy";
import { Context, Effect, Layer, Option, Schema, type Scope } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { SendAuthEmail } from "../contracts/email.ts";
import { cloudSecrets } from "./secrets.ts";
import { authQueryAdapter, bindAuthQueries } from "./auth-database.ts";

/** Bind during initialization; database calls capture the current invocation only. */
export const cloudAuth = (send: SendAuthEmail) =>
  Effect.gen(function* () {
    const settings = yield* cloudAuthSettings.pipe(Effect.orDie);
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
    );
    const auth = yield* BetterAuth({
      ...options,
      plugins: [...options.plugins, observation.plugin],
      // Cookies use hostnames, not ports; cloud dev must not replace self-host sessions.
      advanced: {
        ...options.advanced,
        cookiePrefix: cloudSessionCookiePrefix(settings.url),
        // The deployment migration validates the schema. Alchemy owns a fresh auth
        // instance per event; repeating Kysely introspection would delay every read.
        database: { ...options.advanced.database, validateSchema: false },
      },
      secret: secrets.authSecret,
      migrate: false,
    });
    // Better Auth work runs as Promise code. Bind it to the calling span so each
    // auth SQL timing span is a child of the operation that issued the query.
    const nativeCall = <A>(call: (instance: Effect.Success<typeof auth.auth>) => Promise<A>) =>
      auth.auth.pipe(
        Effect.provide(RuntimeContext.phantom),
        Effect.flatMap((instance) =>
          Effect.flatMap(bindAuthQueries, (bind) =>
            Effect.tryPromise({ try: () => bind(() => call(instance)), catch: (error) => error }),
          ),
        ),
        // The same failure contract as Alchemy's `auth.api` wrappers.
        Effect.catch((error) =>
          isAPIErrorLike(error)
            ? Effect.fail(BetterAuthApiError.fromAPIError(error))
            : Effect.die(error),
        ),
      );
    const adapter = auth.auth.pipe(
      Effect.provide(RuntimeContext.phantom),
      Effect.flatMap((instance) => Effect.promise(() => instance.$context)),
      Effect.flatMap((context) => authQueryAdapter(context.adapter)),
    );
    const identity = Layer.effect(
      Authentication,
      Effect.gen(function* () {
        // Built inside fetch: database work stays in the current invocation's scope.
        return Authentication.of({
          origin: settings.url,
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
            auth.auth
              .pipe(
                Effect.provide(RuntimeContext.phantom),
                Effect.flatMap((native) =>
                  Effect.flatMap(bindAuthQueries, (bind) =>
                    lookupOrganizationSlug(() =>
                      bind(() =>
                        native.api.getOrganization({ headers, query: { organizationId } }),
                      ),
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
    const mcpIdentity = Layer.effect(
      McpAuthentication,
      Effect.gen(function* () {
        return McpAuthentication.of({
          origin: settings.url,
          authenticate: (headers, mode, organization) =>
            auth.auth
              .pipe(
                Effect.provide(RuntimeContext.phantom),
                Effect.flatMap((native) =>
                  Effect.flatMap(bindAuthQueries, (bind) =>
                    Effect.tryPromise({
                      try: () =>
                        bind(() =>
                          native.api.getMcpAccess({ headers, query: { mode, organization } }),
                        ),
                      catch: mcpAuthenticationError,
                    }),
                  ),
                ),
              )
              .pipe(Effect.withSpan("auth.authenticate")),
          browserGrant: (headers, id) =>
            auth.auth.pipe(
              Effect.provide(RuntimeContext.phantom),
              Effect.flatMap((native) =>
                Effect.tryPromise({
                  try: () => native.api.getMcpBrowserAccess({ headers, body: { id } }),
                  catch: mcpAuthenticationError,
                }),
              ),
            ),
          metadata: auth.api.getOAuthServerConfig().pipe(
            Effect.provide(RuntimeContext.phantom),
            Effect.mapError(() => new AuthenticationUnavailable()),
          ),
        });
      }),
    );
    const apiIdentity = Layer.effect(
      ApiAuthentication,
      Effect.gen(function* () {
        return ApiAuthentication.of({
          origin: settings.url,
          authenticate: (headers, organization) =>
            auth.auth
              .pipe(
                Effect.provide(RuntimeContext.phantom),
                Effect.flatMap((native) =>
                  Effect.flatMap(bindAuthQueries, (bind) =>
                    Effect.tryPromise({
                      try: () =>
                        bind(() => native.api.getApiAccess({ headers, query: { organization } })),
                      catch: apiAuthenticationError,
                    }),
                  ),
                ),
              )
              .pipe(Effect.withSpan("auth.authenticate")),
        });
      }),
    );
    const appSessions = Layer.effect(
      HostedAppSessions,
      auth.auth.pipe(
        Effect.provide(RuntimeContext.phantom),
        Effect.flatMap((native) =>
          Effect.tryPromise({
            try: () => native.$context,
            catch: () => new AuthenticationUnavailable(),
          }),
        ),
        Effect.map((context) => hostedAppSessions(context, globalThis.crypto)),
        Effect.withSpan("auth.app_sessions.initialize"),
      ),
    );
    const requestHandler = Effect.flatMap(
      Effect.context<RuntimeContext | HttpServerRequest.HttpServerRequest | Scope.Scope>(),
      (context) =>
        Effect.promise((signal) =>
          callbacks.run({ context, signal }, () =>
            Effect.runPromiseExit(auth.fetch.pipe(Effect.provideContext(context)), { signal }),
          ),
        ).pipe(Effect.flatten),
    );
    const handler = observation
      .observe(requestHandler)
      .pipe(
        Effect.flatMap(clearHeroIdentityOnSignOut),
        Effect.map(HttpServerResponse.setHeader("cache-control", "no-store")),
      );
    return {
      browserSession: (headers: Headers) =>
        auth.api
          .getSession({ headers, query: { disableRefresh: true, disableCookieCache: true } })
          .pipe(
            Effect.provide(RuntimeContext.phantom),
            Effect.flatMap(Schema.decodeUnknownEffect(BrowserSession)),
            Effect.mapError(() => new AuthenticationUnavailable()),
          ),
      identity,
      mcpIdentity,
      apiIdentity,
      appSessions,
      handler,
      origin: settings.url,
      cookiePrefix: cloudSessionCookiePrefix(settings.url),
    };
  });
