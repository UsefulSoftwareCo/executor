import { HostedAppSessions, hostedAppSessions } from "@executor-js/hosted-server/app-ui";
import { AsyncLocalStorage } from "node:async_hooks";
import { APIError } from "better-auth/api";
import { OrganizationId } from "@executor-js/hosted-server";
import { BillingMeter } from "../contracts/billing-meter.ts";
import { billingLive } from "../implementation/billing.ts";
import { clearHeroIdentityOnSignOut } from "../implementation/hero-experiment.ts";
import { recordCloudSignup } from "../implementation/product-analytics.ts";
import { cloudAuthOptions, cloudAuthSettings } from "../implementation/auth-options.ts";
/** Native Alchemy auth binding, shared by the HTTP Worker and MCP session objects. */
import {
  Authentication,
  accountApiKey,
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
import { BetterAuth } from "@alchemy.run/better-auth";
import { cloudSessionCookiePrefix } from "../contracts/browser.ts";
import { RuntimeContext } from "alchemy";
import { Context, Effect, Layer, Option, Schema, type Scope } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { SendAuthEmail } from "../contracts/email.ts";
import { cloudSecrets } from "./secrets.ts";

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
        syncSeats: (id) =>
          runCallback(
            Schema.decodeUnknownEffect(OrganizationId)(id).pipe(
              Effect.flatMap(meter.syncSeats),
              // Membership has already committed. Do not turn a provider outage into a failed membership write.
              // The scheduled authoritative recount repairs this without replaying the user's action.
              Effect.catch(() =>
                Effect.logError("Billing seat sync failed; scheduled reconciliation will retry"),
              ),
              Effect.scoped,
            ),
          ),
      },
      (userId) => runCallback(recordCloudSignup(userId)),
    );
    const auth = yield* BetterAuth({
      ...options,
      // Cookies use hostnames, not ports; cloud dev must not replace self-host sessions.
      advanced: {
        ...options.advanced,
        cookiePrefix: cloudSessionCookiePrefix(settings.url),
        // The deployment migration validates the schema. Alchemy owns a fresh auth
        // instance per event; repeating Kysely introspection would delay every read.
        database: { validateSchema: false },
      },
      secret: secrets.authSecret,
      migrate: false,
    });
    const identity = Layer.effect(
      Authentication,
      Effect.gen(function* () {
        // Built inside fetch: database work stays in the current invocation's scope.
        return Authentication.of({
          origin: settings.url,
          apiKey: (headers) => {
            const internal = new Headers(headers);
            internal.set("origin", settings.url);
            return auth.auth.pipe(
              Effect.provide(RuntimeContext.phantom),
              Effect.flatMap((native) =>
                accountApiKey(
                  () =>
                    native.api.createApiKey({ headers: internal, body: { name: "Executor app" } }),
                  (keyId) => native.api.deleteApiKey({ headers: internal, body: { keyId } }),
                ),
              ),
            );
          },
          oauthRedirectUri: Option.getOrUndefined(settings.oauthRedirectUri),
          current: (headers) =>
            auth.api
              .getSession({ headers, query: { disableRefresh: true, disableCookieCache: true } })
              .pipe(
                Effect.provide(RuntimeContext.phantom),
                Effect.mapError(() => new AuthenticationUnavailable()),
                Effect.flatMap(sessionPrincipal),
              )
              .pipe(Effect.withSpan("auth.current")),
          organization: (reference) =>
            auth.auth.pipe(
              Effect.provide(RuntimeContext.phantom),
              Effect.flatMap((native) => Effect.promise(() => native.$context)),
              Effect.flatMap((context) => resolveOrganizationReference(context.adapter, reference)),
            ),
          organizationSlug: (headers, organizationId) =>
            auth.auth
              .pipe(
                Effect.provide(RuntimeContext.phantom),
                Effect.flatMap((native) =>
                  lookupOrganizationSlug(() =>
                    native.api.getOrganization({ headers, query: { organizationId } }),
                  ),
                ),
              )
              .pipe(Effect.withSpan("auth.organizationSlug")),
          membership: (headers, organizationId) =>
            auth.auth
              .pipe(
                Effect.provide(RuntimeContext.phantom),
                Effect.flatMap((native) =>
                  lookupMembership(() =>
                    native.api.getActiveMemberRole({
                      headers,
                      query: { organizationId },
                      returnHeaders: true,
                    }),
                  ),
                ),
              )
              .pipe(Effect.withSpan("auth.membership")),
          removeOrganization: (organizationId) =>
            auth.auth
              .pipe(
                Effect.provide(RuntimeContext.phantom),
                Effect.flatMap((native) => Effect.promise(() => native.$context)),
                Effect.flatMap((context) =>
                  deleteOrganizationRecords(context.adapter, organizationId),
                ),
              )
              .pipe(Effect.withSpan("auth.removeOrganization")),
        });
      }),
    );
    const mcpIdentity = Layer.effect(
      McpAuthentication,
      Effect.gen(function* () {
        return McpAuthentication.of({
          origin: settings.url,
          authenticate: (headers, mode) =>
            auth.auth
              .pipe(
                Effect.provide(RuntimeContext.phantom),
                Effect.flatMap((native) =>
                  Effect.tryPromise({
                    try: () => native.api.getMcpAccess({ headers, query: { mode } }),
                    catch: mcpAuthenticationError,
                  }),
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
                  Effect.tryPromise({
                    try: () => native.api.getApiAccess({ headers, query: { organization } }),
                    catch: apiAuthenticationError,
                  }),
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
    const handler = requestHandler.pipe(
      Effect.flatMap(clearHeroIdentityOnSignOut),
      Effect.map(HttpServerResponse.setHeader("cache-control", "no-store")),
    );
    return {
      identity,
      mcpIdentity,
      apiIdentity,
      appSessions,
      handler,
      origin: settings.url,
      cookiePrefix: cloudSessionCookiePrefix(settings.url),
    };
  });
