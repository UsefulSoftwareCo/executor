import { BrowserSession } from "@executor-js/hosted-server/browser/contracts";
import { HostedAppSessions } from "@executor-js/hosted-server/app-ui";
import { authObservability } from "../implementation/auth-observability.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { APIError } from "better-auth/api";
import { OrganizationId, recordCredential, recordSecurityAudit } from "@executor-js/hosted-server";
import { BillingMeter } from "../contracts/billing-meter.ts";
import { billingLive } from "../implementation/billing.ts";
import {
  clearSiteVisitorOnSignOut,
  recordCloudSignup,
  recordCloudLogin,
} from "../implementation/product-analytics.ts";
import { cloudAuthOptions, cloudAuthSettings } from "../implementation/auth-options.ts";
import { isOAuthProxyProduction } from "../implementation/oauth-proxy-settings.ts";
import {
  CurrentUsage,
  CurrentUserId,
  recordUsage,
  usageFailure,
  SessionAuthentication,
  AuthenticationUnavailable,
  sessionPrincipal,
  lookupMembership,
  deleteOrganizationRecords,
  deleteUserRecords,
  lookupOrganizationSlug,
  resolveOrganizationReference,
  BearerAuthentication,
  apiBearerAccess,
  callerSpanAttributes,
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
import { cloudSecrets, v1McpForwardSecret, v1SessionHandoffSecret } from "./secrets.ts";
import { V1HandoffSessionFailed, v1SessionHandoff } from "../implementation/v1-session-handoff.ts";
import { recordAuthRefusal } from "../implementation/auth-refusals.ts";
import { cloudAuthRateLimit } from "./stage.ts";
import { AuthDatabase, appSessionsPerCall, boundAuthAdapter } from "./auth-database.ts";
import { invocationSql } from "./invocation-database.ts";
import { mcpAuthentication } from "./mcp-auth.ts";
import { v1CapturedApiKeys } from "../implementation/v1-captured-api-keys.ts";
import { cloudV1WorkOSKeys } from "./v1-api-key-settings.ts";
import { resolveLegacyResource } from "../implementation/v1-legacy-mcp.ts";
import { authAudit } from "../implementation/auth-audit.ts";

export const cloudAuth = (send: SendAuthEmail) =>
  Effect.gen(function* () {
    const environment = yield* Cloudflare.WorkerEnvironment;
    const settings = {
      ...(yield* cloudAuthSettings.pipe(Effect.orDie)),
      rateLimitEnabled: yield* cloudAuthRateLimit(environment.AUTH_RATE_LIMIT_SWITCH === true).pipe(
        Effect.orDie,
      ),
    };
    const secrets = yield* cloudSecrets.pipe(Effect.orDie);
    const v1Forward = yield* v1McpForwardSecret;
    const v1Handoff = yield* v1SessionHandoffSecret;
    const meter = yield* BillingMeter.pipe(Effect.provide(yield* billingLive));
    const withSql = yield* invocationSql;
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
          Effect.gen(function* () {
            yield* recordUsage("product_operation_completed", {
              area: "auth",
              operation: usage.operation,
              status_code: usage.status,
              ok: usage.status < 400,
              outcome: usage.status < 400 ? "success" : "failure",
            });
            if (usage.status >= 400) return;
            if (usage.operation === "organization.invite-member")
              yield* recordUsage("invitation_sent");
            else if (usage.operation === "organization.accept-invitation")
              yield* recordUsage("invitation_accepted");
          }).pipe(
            Effect.provideService(CurrentUserId, usage.userId),
            Effect.provideService(CurrentUsage, { source: "dashboard" }),
          ),
        ),
      {
        resolveResource: (input) =>
          runCallback(withSql(resolveLegacyResource(settings.resourceOrigins, input))),
        onRefreshRejected: observation.refreshRejected,
        onGrantCreated: (grant) =>
          runCallback(
            (grant.kind === "desktop"
              ? Effect.void
              : recordUsage("agent_connected", { grant_kind: grant.kind }, grant.organization)
            ).pipe(
              Effect.provideService(CurrentUserId, grant.userId),
              Effect.provideService(CurrentUsage, {
                source: "dashboard",
                client_id: grant.clientId,
              }),
            ),
          ),
      },
      observation.providerPhoto,
    );
    const database = yield* AuthDatabase;
    const makeInstance = (secret: string) =>
      betterAuth({
        ...options,
        plugins: [
          ...options.plugins,
          authAudit((event, session) =>
            runCallback(
              Effect.andThen(
                session === undefined
                  ? Effect.void
                  : recordCredential({ kind: "session", ...session }),
                recordSecurityAudit(event),
              ),
            ).catch(() => undefined),
          ),
          observation.plugin,
        ],
        database: database.options,
        secret,
        advanced: {
          ...options.advanced,
          cookiePrefix: cloudSessionCookiePrefix(settings.url),
          database: { ...options.advanced.database, validateSchema: false },
          backgroundTasks: { handler: database.background },
        },
      });
    let instance: ReturnType<typeof makeInstance> | undefined;
    let routes: ReturnType<typeof routeTemplates> | undefined;
    const native = secrets.authSecret.pipe(
      Effect.map((secret) => (instance ??= makeInstance(Redacted.value(secret)))),
    );
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
    const identity = Layer.effect(
      SessionAuthentication,
      Effect.gen(function* () {
        return SessionAuthentication.of({
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
          removeUser: (user) =>
            adapter
              .pipe(Effect.flatMap((adapter) => deleteUserRecords(adapter, user)))
              .pipe(Effect.withSpan("auth.removeUser")),
        });
      }),
    );
    const origins = {
      origin: settings.url,
      resourceOrigins: settings.resourceOrigins,
      issuer: settings.issuer,
    };
    const v1Keys = v1CapturedApiKeys(yield* cloudV1WorkOSKeys.pipe(Effect.orDie));
    const mcpIdentity = mcpAuthentication(origins, bound, withSql, v1Forward, v1Keys);
    const apiIdentity = Layer.effect(
      BearerAuthentication,
      Effect.gen(function* () {
        return BearerAuthentication.of({
          ...origins,
          authenticate: (headers, organization, options) =>
            withSql(
              apiBearerAccess(
                origins,
                { headers, organization, desktop: options?.desktop, tools: options?.tools },
                v1Keys,
              ),
            ).pipe(
              Effect.tap(({ access, userId }) =>
                Effect.annotateCurrentSpan(callerSpanAttributes(access.organization, userId)),
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
      const pathname = new URL(web.url).pathname;
      yield* routes.record(pathname);
      const context = yield* Effect.context<
        RuntimeContext | HttpServerRequest.HttpServerRequest | Scope.Scope
      >();
      const response = yield* Effect.promise((signal) =>
        callbacks.run({ context, signal }, () => bind(() => instance.handler(web))),
      );
      if (response.body === null) {
        yield* recordAuthRefusal(response.status, pathname, new Uint8Array(), web.headers);
        return HttpServerResponse.fromWeb(response);
      }
      const body = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()));
      yield* recordAuthRefusal(response.status, pathname, body, web.headers);
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
    const browserSession = (headers: Headers) =>
      nativeCall((instance) =>
        instance.api.getSession({
          headers,
          query: { disableRefresh: true, disableCookieCache: true },
        }),
      ).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(BrowserSession)),
        Effect.mapError(() => new AuthenticationUnavailable()),
      );
    const v1HandoffHandler = v1SessionHandoff({
      secret: v1Handoff,
      withSql,
      currentUser: (headers) =>
        browserSession(headers).pipe(Effect.map((session) => session?.user.id)),
      startSession: (headers, userId, organizationId) =>
        Effect.gen(function* () {
          const [instance, bind] = yield* bound;
          const context = yield* Effect.context<
            RuntimeContext | HttpServerRequest.HttpServerRequest | Scope.Scope
          >();
          const result = yield* Effect.tryPromise({
            try: (signal) =>
              callbacks.run({ context, signal }, () =>
                bind(() =>
                  instance.api.startV1HandoffSession({
                    headers,
                    body: { userId, organizationId },
                    returnHeaders: true,
                  }),
                ),
              ),
            catch: () => new V1HandoffSessionFailed(),
          });
          return result.headers.getSetCookie();
        }),
    });
    return {
      browserSession,
      v1Handoff: v1HandoffHandler,
      identity,
      mcpIdentity,
      apiIdentity,
      appSessions,
      agentGrants: grantExpiry((run) => nativeCall((instance) => run(instance.api))),
      handler,
      origin: settings.url,
      resourceOrigins: settings.resourceOrigins,
      hosts: settings.hosts,
      cookiePrefix: cloudSessionCookiePrefix(settings.url),
      returnsStageAccountCallback: (origin: string) =>
        isOAuthProxyProduction(settings.hosts, settings.oauthProxy)
          ? authContext.pipe(
              Effect.map((context) => context.isTrustedOrigin(origin)),
              Effect.provide(RuntimeContext.phantom),
            )
          : Effect.succeed(false),
    };
  });
