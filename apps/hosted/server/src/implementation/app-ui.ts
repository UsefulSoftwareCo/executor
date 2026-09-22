import { CurrentAuthorization } from "../contracts/authorization.ts";
import { fullAuthority } from "@executor-js/authorization";
import { GroupDatabase } from "../contracts/groups.ts";
import { requireAppAccess } from "./resource-policy.ts";
/** Hosted policy around the shared app browser protocol and retained asset renderer. */
import {
  AccountRequired,
  AccountNotFound,
  AccountSelectionInvalid,
  OAuthReconnectRequired,
  AppNotFound,
  DeploymentId,
  DeploymentNotFound,
  type Deployment,
} from "@executor-js/sdk/core";
import { AppSignInApi, AppSignInCode, appPrivateHeaders, appSignInPage } from "apps/ui/auth";
import {
  AppUiApi,
  UiDeploymentChanged,
  type UiOperation,
  UiFailed,
  UiForbidden,
  UiUnauthorized,
} from "apps/ui/contracts";
import { appAsset, appDocument } from "apps/ui/serving";
import { receiveBrowserTelemetry } from "@executor-js/telemetry/http";
import { Clock, Effect, Option, Redacted, Schema, Stream } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  HostedAppRuntime,
  HostedAppSessions,
  HostedAppUiApi,
  type AppUiTarget,
} from "../contracts/app-ui.ts";
import { CurrentPrincipal, CurrentUserId } from "../contracts/auth.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import {
  CurrentOrganization,
  OrganizationForbidden,
  organizationOwner,
} from "../contracts/organization.ts";
import { selectedApp } from "./access.ts";
import { executeAppData } from "./app-data.ts";
import type { appAddresses } from "./app-addresses.ts";

const unavailable = () => new UiFailed({ reason: "unavailable" });
const privateJson = (value: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(value, { status, headers: appPrivateHeaders });
const failure = (error: UiUnauthorized | UiForbidden | UiFailed) =>
  privateJson(
    error,
    Schema.is(UiUnauthorized)(error) ? 401 : Schema.is(UiForbidden)(error) ? 403 : 422,
  );

/** Build handlers only. The host chooses their route table, origin base, runtime, and Better Auth store. */
export const hostedAppUi = (addresses: ReturnType<typeof appAddresses>) => {
  const requestOrigin = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const host = addresses.fromHost(request.headers.host);
    if (Option.isNone(host)) return yield* new UiForbidden();
    const safe = request.method === "GET" || request.method === "HEAD";
    if (
      (!safe && request.headers.origin !== host.value.origin) ||
      (request.headers.origin !== undefined && request.headers.origin !== host.value.origin) ||
      (request.headers["sec-fetch-site"] === "cross-site" &&
        !(request.method === "GET" && request.headers["sec-fetch-mode"] === "navigate"))
    )
      return yield* new UiForbidden();
    return { request, host: host.value };
  });
  const target = Effect.gen(function* () {
    const { request, host } = yield* requestOrigin;
    const sessions = yield* HostedAppSessions;
    const organization = yield* sessions.organization({ slug: host.slug });
    const executor = yield* Effect.flatten(HostedExecutor).pipe(Effect.mapError(unavailable));
    const matches = yield* executor.apps
      .list({ owner: organizationOwner(organization.id), ...host.find })
      .pipe(Effect.mapError(unavailable));
    const app = matches[0];
    if (app === undefined) return yield* new UiForbidden();
    return {
      request,
      target: { app: app.id, slug: host.slug, origin: host.origin, organization: organization.id },
    };
  });
  const source = (target: Pick<AppUiTarget, "app" | "organization">, deployment?: DeploymentId) =>
    Effect.gen(function* () {
      const executor = yield* Effect.flatten(HostedExecutor);
      const owner = organizationOwner(target.organization);
      const app = yield* executor.apps.get({ owner, app: target.app });
      const version = yield* executor.apps.source({
        owner,
        app: app.id,
        ...(deployment === undefined ? {} : { deployment }),
      });
      if (version.owner !== owner) return yield* new UiForbidden();
      return { app, version };
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(AppNotFound)(error) ||
        Schema.is(DeploymentNotFound)(error) ||
        Schema.is(UiForbidden)(error)
          ? new UiForbidden()
          : unavailable(),
      ),
    );
  const usable = (target: AppUiTarget) =>
    source(target).pipe(
      Effect.flatMap(({ app, version }) => {
        if (!version.files.some((file) => file.path === "ui/index.html"))
          return Effect.fail(unavailable());
        if (Object.keys(app.requirements.accounts).some((slot) => app.accounts[slot] === undefined))
          return Effect.fail(new UiFailed({ reason: "account_required" }));
        return Effect.succeed(app);
      }),
    );
  const secure = (origin: string) => new URL(origin).protocol === "https:";
  const sessionCookie = (origin: string) => `${secure(origin) ? "__Host-" : ""}executor_app`;
  const attemptCookie = (origin: string, request: string) =>
    `${secure(origin) ? "__Host-" : ""}executor_app_attempt_${request}`;
  const cookieOptions = (origin: string) => ({
    path: "/",
    httpOnly: true,
    secure: secure(origin),
    sameSite: "strict" as const,
  });
  const authorize = Effect.gen(function* () {
    const resolved = yield* target;
    const token = Schema.decodeUnknownOption(AppSignInCode)(
      resolved.request.cookies[sessionCookie(resolved.target.origin)],
    );
    if (Option.isNone(token)) return yield* new UiUnauthorized();
    const sessions = yield* HostedAppSessions;
    const access = yield* sessions.current(resolved.target, token.value);
    const { app } = yield* source(resolved.target);
    const executor = yield* Effect.flatten(HostedExecutor).pipe(Effect.mapError(unavailable));
    yield* selectedApp(executor, access.owner, app.id).pipe(
      Effect.provideService(CurrentOrganization, access),
      Effect.provideService(CurrentUserId, access.userId),
      Effect.mapError((error) =>
        Schema.is(OrganizationForbidden)(error) ? new UiForbidden() : unavailable(),
      ),
    );
    return { ...resolved, access, app };
  });
  const assets = (version: Deployment, path: string) =>
    Effect.gen(function* () {
      const runtime = yield* HostedAppRuntime;
      if (runtime.asset === undefined) return yield* unavailable();
      return yield* runtime
        .asset({ build: version.build, path })
        .pipe(Effect.mapError(unavailable));
    });
  const appAuth = HttpApiBuilder.group(AppSignInApi, "appSignIn", (handlers) =>
    handlers
      .handle("start", ({ payload }) =>
        Effect.gen(function* () {
          const resolved = yield* target;
          yield* usable(resolved.target);
          const sessions = yield* HostedAppSessions;
          const attempt = yield* sessions.begin(resolved.target, payload.returnTo);
          const login = new URL("/app-auth", addresses.dashboardOrigin);
          login.searchParams.set("request", attempt.request);
          return yield* privateJson({ url: login.href }).pipe(
            HttpServerResponse.setCookie(
              attemptCookie(resolved.target.origin, attempt.request),
              Redacted.value(attempt.proof),
              {
                ...cookieOptions(resolved.target.origin),
                maxAge: "10 minutes",
              },
            ),
            Effect.orDie,
          );
        }),
      )
      .handle("complete", ({ payload }) =>
        Effect.gen(function* () {
          const resolved = yield* target;
          const proof = Schema.decodeUnknownOption(AppSignInCode)(
            resolved.request.cookies[attemptCookie(resolved.target.origin, payload.request)],
          );
          if (Option.isNone(proof)) return yield* new UiUnauthorized();
          yield* usable(resolved.target);
          const sessions = yield* HostedAppSessions;
          const completed = yield* sessions.complete(
            resolved.target,
            payload.request,
            payload.code,
            proof.value,
          );
          return yield* privateJson({ returnTo: completed.returnTo }).pipe(
            HttpServerResponse.setCookie(
              sessionCookie(resolved.target.origin),
              Redacted.value(completed.token),
              {
                ...cookieOptions(resolved.target.origin),
                sameSite: "lax",
                maxAge: Math.max(
                  0,
                  completed.expiresAt.getTime() - (yield* Clock.currentTimeMillis),
                ),
              },
            ),
            Effect.flatMap(
              HttpServerResponse.expireCookie(
                attemptCookie(resolved.target.origin, payload.request),
                cookieOptions(resolved.target.origin),
              ),
            ),
            Effect.orDie,
          );
        }),
      ),
  );
  const dashboard = HttpApiBuilder.group(HostedAppUiApi, "appUi", (handlers) =>
    handlers
      .handle("location", ({ params }) =>
        Effect.gen(function* () {
          const access = yield* CurrentOrganization;
          yield* requireAppAccess(params.app, "use").pipe(Effect.mapError(() => new UiForbidden()));
          const { app, version } = yield* source({
            app: params.app,
            organization: access.organization,
          });
          if (!addresses.enabled) return { url: null };
          const sessions = yield* HostedAppSessions;
          const organization = yield* sessions.organization({ id: access.organization });
          return {
            url: version.files.some((file) => file.path === "ui/index.html")
              ? yield* addresses.origin(app, organization.slug)
              : null,
          };
        }),
      )
      .handle("authorize", ({ payload }) =>
        Effect.gen(function* () {
          const sessions = yield* HostedAppSessions;
          const grant = yield* sessions.authorize(payload.request, yield* CurrentPrincipal);
          const currentOrganization = yield* sessions.organization({
            id: grant.target.organization,
          });
          const { app } = yield* source(grant.target);
          if (
            !addresses.enabled ||
            currentOrganization.slug !== grant.target.slug ||
            (yield* addresses.origin(app, currentOrganization.slug)) !== grant.target.origin
          )
            return yield* new UiForbidden();
          const principal = yield* CurrentPrincipal;
          const access = yield* sessions.access(principal, grant.target);
          yield* requireAppAccess(grant.target.app, "use").pipe(
            Effect.provideService(CurrentOrganization, access),
            Effect.provideService(CurrentUserId, principal.userId),
            Effect.mapError(() => new UiForbidden()),
          );
          yield* usable(grant.target);
          const callback = new URL("/_executor/auth/callback", grant.target.origin);
          callback.hash = new URLSearchParams({
            request: payload.request,
            code: Redacted.value(grant.code),
          }).toString();
          return { url: Redacted.make(callback.href) };
        }),
      ),
  );
  const dataFailure = (error: unknown) =>
    Schema.is(OrganizationForbidden)(error)
      ? new UiForbidden()
      : new UiFailed({
          reason:
            Schema.is(AccountRequired)(error) ||
            Schema.is(AccountNotFound)(error) ||
            Schema.is(AccountSelectionInvalid)(error) ||
            Schema.is(OAuthReconnectRequired)(error)
              ? "account_required"
              : "operation_failed",
        });
  const dataInput = (payload: typeof UiOperation.Type) =>
    Effect.gen(function* () {
      const current = yield* authorize;
      const executor = yield* Effect.flatten(HostedExecutor).pipe(Effect.mapError(unavailable));
      yield* selectedApp(executor, current.access.owner, current.app.id).pipe(
        Effect.provideService(CurrentOrganization, current.access),
        Effect.provideService(CurrentUserId, current.access.userId),
        Effect.mapError(dataFailure),
      );
      const deployment = yield* Schema.decodeUnknownEffect(DeploymentId)(payload.deployment).pipe(
        Effect.mapError(unavailable),
      );
      if (deployment !== current.app.activeDeployment) return yield* new UiDeploymentChanged();
      return {
        current,
        input: { app: current.app.id, deployment, name: payload.name, input: payload.input },
      };
    });
  const data = (kind: "query" | "mutate", payload: typeof UiOperation.Type) =>
    Effect.gen(function* () {
      const { current, input } = yield* dataInput(payload);
      return yield* executeAppData(kind, input).pipe(
        Effect.provideService(CurrentOrganization, current.access),
        Effect.provideService(CurrentAuthorization, fullAuthority),
        Effect.provideService(CurrentUserId, current.access.userId),
        Effect.mapError(dataFailure),
      );
    });
  const calls = HttpApiBuilder.group(AppUiApi, "ui", (handlers) =>
    handlers
      .handle("query", ({ payload }) => data("query", payload))
      .handle("mutate", ({ payload }) => data("mutate", payload))
      .handle("subscribe", ({ payload }) =>
        Effect.gen(function* () {
          const { input, current } = yield* dataInput(payload);
          const executor = yield* Effect.flatten(HostedExecutor).pipe(Effect.mapError(unavailable));
          const check = dataInput(payload);
          const context = yield* Effect.context<Effect.Services<typeof check>>();
          const access = check.pipe(Effect.provideContext(context));
          const source = yield* executor.appData
            .subscribe(input)
            .pipe(Effect.mapError(dataFailure));
          return Stream.merge(
            source.pipe(
              Stream.provideService(CurrentUserId, current.access.userId),
              Stream.provideService(CurrentOrganization, current.access),
              Stream.mapError(dataFailure),
              Stream.mapEffect((snapshot) =>
                access.pipe(Effect.as({ type: "snapshot" as const, value: snapshot.value })),
              ),
            ),
            Stream.tick("5 seconds").pipe(
              Stream.mapEffect(() => access),
              Stream.map(() => ({ type: "heartbeat" as const })),
            ),
          );
        }),
      ),
  );
  const htmlFailure = Effect.catchTags({
    UiUnauthorized: () =>
      Effect.succeed(
        HttpServerResponse.text("Sign in to this app to continue.", {
          status: 401,
          headers: appPrivateHeaders,
        }),
      ),
    UiForbidden: () =>
      Effect.succeed(
        HttpServerResponse.text("App unavailable.", { status: 403, headers: appPrivateHeaders }),
      ),
    UiFailed: () =>
      Effect.succeed(
        HttpServerResponse.text("App unavailable.", { status: 422, headers: appPrivateHeaders }),
      ),
  });
  const page = Effect.gen(function* () {
    const current = yield* authorize;
    const { version } = yield* source(current.target);
    return yield* appDocument({
      origin: current.target.origin,
      deployment: version.id,
      asset: (path) => assets(version, path),
    });
  }).pipe(
    Effect.catchTag("UiUnauthorized", (error) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (
          request.method === "GET" &&
          (request.headers["sec-fetch-mode"] === "navigate" ||
            request.headers.accept?.includes("text/html"))
        )
          return appSignInPage();
        return yield* error;
      }),
    ),
    htmlFailure,
  );
  const asset = Effect.gen(function* () {
    const current = yield* authorize;
    const params = yield* HttpRouter.schemaPathParams(
      Schema.Struct({ deployment: DeploymentId, "*": Schema.NonEmptyString }),
    ).pipe(Effect.mapError(unavailable));
    const { version } = yield* source(current.target, params.deployment);
    return appAsset(yield* assets(version, params["*"]));
  }).pipe(htmlFailure);
  const originAccess = HttpRouter.middleware((response) =>
    requestOrigin.pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed(failure(error)),
        onSuccess: () => response,
      }),
    ),
  );
  const sessionAccess = HttpRouter.middleware(
    Effect.gen(function* () {
      const sessions = yield* HostedAppSessions;
      const executor = yield* HostedExecutor;
      const database = yield* GroupDatabase;
      const check = authorize.pipe(
        Effect.provideService(GroupDatabase, database),
        Effect.provideService(HostedAppSessions, sessions),
        Effect.provideService(HostedExecutor, executor),
      );
      return (response) =>
        check.pipe(
          Effect.matchEffect({
            onFailure: (error) => Effect.succeed(failure(error)),
            onSuccess: () => response,
          }),
        );
    }),
  );
  const telemetry = (signal: "traces" | "logs") =>
    authorize.pipe(
      Effect.flatMap(({ app }) =>
        receiveBrowserTelemetry(signal, app.activeDeployment ?? undefined),
      ),
      htmlFailure,
    );
  return { appAuth, dashboard, calls, page, asset, originAccess, sessionAccess, telemetry };
};
