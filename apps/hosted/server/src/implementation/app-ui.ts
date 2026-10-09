import { CurrentAuthorization } from "../contracts/authorization.ts";
import { CurrentUsage, recordUsage } from "../contracts/product-analytics.ts";
import { fullAuthority } from "@executor-js/authorization";
import { GroupDatabase } from "../contracts/groups.ts";
import { requireAccountAccess, requireAppAccess, requireAppUse } from "./resource-policy.ts";
/** Hosted policy around the shared app browser protocol and retained asset renderer. */
import {
  ProfileId,
  ProfileConflict,
  AccountRequired,
  AccountNotFound,
  AccountSelectionInvalid,
  OAuthReconnectRequired,
  AppNotDeployed,
  AppNotFound,
  credentialsRejected,
  profileAccountProblems,
  DeploymentId,
  DeploymentNotFound,
  type App,
  type DeploymentMetadata,
  type SelectedAccounts,
} from "@executor-js/sdk/core";
import {
  AppSignInCallback,
  AppSignInCode,
  AppSignInId,
  AppReturnPath,
  appPrivateHeaders,
  appRedirect,
  appSignInCallback,
  appSignInFailed,
  type AppSignInFailure,
} from "apps/ui/auth";
import {
  AppUiApi,
  UiDeploymentChanged,
  type UiOperation,
  UiFailed,
  UiForbidden,
  UiUnauthorized,
} from "apps/ui/contracts";
import { appAsset, appDocument, appWatchScript } from "apps/ui/serving";
import { receiveBrowserTelemetry } from "@executor-js/telemetry/http";
import { currentTraceContext, recordRoute } from "@executor-js/telemetry";
import { Clock, Context, Effect, Option, Redacted, Schema, Stream } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  AppUiUnavailable,
  HostedAppRuntime,
  HostedAppSessions,
  HostedAppUiApi,
  type AppUiAddressInvalid,
  type AppUiTarget,
} from "../contracts/app-ui.ts";
import { Authentication, CurrentUserId, type Principal } from "../contracts/auth.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import {
  CurrentOrganization,
  OrganizationForbidden,
  organizationOwner,
  type OrganizationAccess,
} from "../contracts/organization.ts";
import { checkAccounts, ownProfile, selectedProfile } from "./access.ts";
import type { appAddresses } from "./app-addresses.ts";

/** Authorization belongs to one HTTP request, never a shared or timed cache. */
class CurrentAppUi extends Context.Service<
  CurrentAppUi,
  {
    readonly target: AppUiTarget;
    readonly app: App;
    readonly access: OrganizationAccess & { readonly userId: string };
  }
>()("hosted/CurrentAppUi") {}

const unavailable = () => new UiFailed({ reason: "unavailable" });
/** Anonymous fetches cannot serve app content; browser navigations still start sign-in. */
const anonymousNonNavigation = (request: HttpServerRequest.HttpServerRequest, cookieName: string) =>
  (request.method === "GET" || request.method === "HEAD") &&
  request.headers["sec-fetch-mode"] !== "navigate" &&
  !request.headers.accept?.includes("text/html") &&
  !Object.hasOwn(request.cookies, cookieName);
const accountIds = (accounts: SelectedAccounts) =>
  Object.values(accounts).flatMap((value) => (typeof value === "string" ? [value] : value));
const privateJson = (value: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(value, { status, headers: appPrivateHeaders });
const failure = (error: UiUnauthorized | UiForbidden | UiFailed) =>
  privateJson(
    error,
    Schema.is(UiUnauthorized)(error) ? 401 : Schema.is(UiForbidden)(error) ? 403 : 422,
  );

/**
 * Build handlers only. The host chooses their route table, origin base, runtime, and Better Auth
 * store. Domain status runs inside the location request and may use that request's services.
 */
export const hostedAppUi = <R = never>(
  addresses: ReturnType<typeof appAddresses>,
  domainStatus: (
    team: Pick<AppUiTarget, "slug"> & { readonly id: AppUiTarget["organization"] },
  ) => Effect.Effect<"ready" | "pending" | "failed", UiFailed | AppUiAddressInvalid, R> = () =>
    Effect.succeed("ready"),
) => {
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
      app,
      target: { app: app.id, slug: host.slug, origin: host.origin, organization: organization.id },
    };
  });
  const deployment = (app: App, requested?: DeploymentId) =>
    Effect.gen(function* () {
      const id = requested ?? app.activeDeployment;
      if (id === null) return yield* unavailable();
      const executor = yield* Effect.flatten(HostedExecutor);
      return yield* executor.apps.deployment({
        owner: app.owner,
        app: app.id,
        deployment: id,
        deploymentOwner: app.owner,
      });
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(AppNotFound)(error) || Schema.is(DeploymentNotFound)(error)
          ? new UiForbidden()
          : unavailable(),
      ),
    );
  const loadApp = (target: AppUiTarget) =>
    Effect.flatten(HostedExecutor).pipe(
      Effect.flatMap((executor) =>
        executor.apps.get({
          owner: organizationOwner(target.organization),
          app: target.app,
        }),
      ),
      Effect.mapError((error) =>
        Schema.is(AppNotFound)(error) ? new UiForbidden() : unavailable(),
      ),
    );
  const secure = (origin: string) => new URL(origin).protocol === "https:";
  const sessionCookie = (origin: string) => `${secure(origin) ? "__Host-" : ""}executor_app`;
  const attemptCookie = (origin: string, request: string) =>
    `${secure(origin) ? "__Host-" : ""}executor_app_attempt_${request}`;
  const cookieOptions = (origin: string) => ({
    path: "/",
    httpOnly: true,
    secure: secure(origin),
    // Lax, not Strict: the attempt cookie must reach the callback when the dashboard redirects
    // there from its own site. Redeeming a code still needs this browser's attempt proof.
    sameSite: "lax" as const,
  });
  const authorizeTarget = (resolved: Effect.Success<typeof target>) =>
    Effect.gen(function* () {
      const token = Schema.decodeUnknownOption(AppSignInCode)(
        resolved.request.cookies[sessionCookie(resolved.target.origin)],
      );
      if (Option.isNone(token)) return yield* new UiUnauthorized();
      const sessions = yield* HostedAppSessions;
      const identity = yield* sessions.current(resolved.target, token.value);
      const app = resolved.app;
      const access = yield* requireAppUse(app, resolved.target.organization, identity.userId).pipe(
        Effect.mapError((error) =>
          Schema.is(OrganizationForbidden)(error) ? new UiForbidden() : unavailable(),
        ),
      );
      return { ...resolved, access, app };
    });
  const authorize = Effect.flatMap(target, authorizeTarget);
  const assets = (version: DeploymentMetadata, path: string) =>
    Effect.gen(function* () {
      const runtime = yield* HostedAppRuntime;
      if (runtime.asset === undefined) return yield* unavailable();
      return yield* runtime
        .asset({ build: version.build, path })
        .pipe(Effect.mapError(unavailable));
    });
  /** A page visit without an app session starts an attempt and goes straight to the dashboard. */
  const beginSignIn = (resolved: Effect.Success<typeof target>) =>
    Effect.gen(function* () {
      if (resolved.app.activeDeployment === null) return yield* unavailable();
      const url = new URL(resolved.request.url, resolved.target.origin);
      // A fragment never reaches the server. Browsers carry it across redirects whose
      // Location has none, so every hop below keeps the original fragment intact.
      const returnTo = yield* Schema.decodeUnknownEffect(AppReturnPath)(
        url.pathname + url.search,
      ).pipe(Effect.mapError(() => new UiForbidden()));
      const sessions = yield* HostedAppSessions;
      const attempt = yield* sessions.begin(resolved.target, returnTo);
      const login = new URL("/app-auth", addresses.dashboardOrigin);
      login.searchParams.set("request", attempt.request);
      return yield* appRedirect(login.href).pipe(
        HttpServerResponse.setCookie(
          attemptCookie(resolved.target.origin, attempt.request),
          Redacted.value(attempt.proof),
          { ...cookieOptions(resolved.target.origin), maxAge: "10 minutes" },
        ),
        Effect.orDie,
      );
    });
  /** Check the dashboard login's access to the attempt's app, then issue its one-time code. */
  const authorizeAttempt = (request: AppSignInId, principal: Principal) =>
    Effect.gen(function* () {
      const sessions = yield* HostedAppSessions;
      const attempt = yield* sessions.pending(request);
      const [organization, app, access] = yield* Effect.all(
        [
          sessions.organization({ id: attempt.organization }),
          loadApp(attempt),
          sessions.access(principal, attempt),
        ],
        { concurrency: "unbounded" },
      );
      if (
        !addresses.enabled ||
        organization.slug !== attempt.slug ||
        (yield* addresses.origin(app, organization.slug)) !== attempt.origin
      )
        return yield* new UiForbidden();
      yield* requireAppAccess(attempt.app, "use").pipe(
        Effect.provideService(CurrentOrganization, access),
        Effect.provideService(CurrentUserId, principal.userId),
        Effect.mapError(() => new UiForbidden()),
      );
      if (app.activeDeployment === null) return yield* unavailable();
      const code = yield* sessions.grant(request, attempt, principal);
      return appSignInCallback(attempt.origin, request, Redacted.value(code));
    });
  const signInFailure = (error: { readonly _tag: string }): AppSignInFailure =>
    error._tag === "UiUnauthorized"
      ? "ended"
      : error._tag === "UiForbidden" || error._tag === "OrganizationForbidden"
        ? "forbidden"
        : "unavailable";
  /**
   * The dashboard's `/app-auth` resolves on the server: signed out goes to login, signed in
   * redirects to the app's callback. Only a missing request or a failure renders the page.
   */
  const signIn = <E, R>(page: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, addresses.dashboardOrigin);
      const attempt = Schema.decodeUnknownOption(AppSignInId)(url.searchParams.get("request"));
      if (Option.isNone(attempt)) return yield* page;
      const principal = yield* Effect.flatMap(Authentication, (authentication) =>
        authentication.current(new Headers(request.headers)),
      );
      if (principal === null) {
        const login = new URLSearchParams({ redirect: `/app-auth?request=${attempt.value}` });
        return appRedirect(`/login?${login}`);
      }
      return yield* authorizeAttempt(attempt.value, principal).pipe(
        Effect.map(appRedirect),
        Effect.catch((error) =>
          Effect.succeed(
            appRedirect(`/app-auth?${new URLSearchParams({ failure: signInFailure(error) })}`),
          ),
        ),
      );
    });
  const dashboard = HttpApiBuilder.group(HostedAppUiApi, "appUi", (handlers) =>
    handlers.handle("location", ({ params }) =>
      Effect.gen(function* () {
        const access = yield* CurrentOrganization;
        // Missing and inaccessible apps fail alike, before the app is read.
        yield* requireAppAccess(params.app, "use");
        const executor = yield* Effect.flatten(HostedExecutor);
        const app = yield* executor.apps.get({ owner: access.owner, app: params.app });
        if (app.activeDeployment === null) return yield* new AppNotDeployed({ app: app.id });
        const version = yield* executor.apps.deployment({
          owner: app.owner,
          app: app.id,
          deployment: app.activeDeployment,
          deploymentOwner: app.owner,
        });
        // The build, organization and domain reads below fail only when their records are unavailable.
        const page = yield* assets(version, "index.html").pipe(
          Effect.mapError(() => new AppUiUnavailable()),
        );
        if (!addresses.enabled || page === undefined)
          return { status: "unavailable" as const, url: null };
        const sessions = yield* HostedAppSessions;
        const organization = yield* sessions
          .organization({ id: access.organization })
          .pipe(Effect.mapError(() => new AppUiUnavailable()));
        const url = yield* addresses
          .origin(app, organization.slug)
          .pipe(Effect.catchTag("UiFailed", () => Effect.fail(new AppUiUnavailable())));
        const status = yield* domainStatus(organization).pipe(
          Effect.catchTag("UiFailed", () => Effect.fail(new AppUiUnavailable())),
        );
        return status === "ready" ? { status, url } : { status, url: null };
      }),
    ),
  );
  const dataFailure = (error: unknown) =>
    Schema.is(ProfileConflict)(error) && error.reason === "revision"
      ? new UiDeploymentChanged()
      : Schema.is(OrganizationForbidden)(error)
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
  const dataInput = (payload: typeof UiOperation.Type, current: typeof CurrentAppUi.Service) =>
    Effect.gen(function* () {
      const profile = yield* Schema.decodeUnknownEffect(Schema.optional(ProfileId))(
        payload.profile,
      ).pipe(Effect.mapError(unavailable));
      if (profile !== undefined) {
        const executor = yield* Effect.flatten(HostedExecutor).pipe(Effect.mapError(unavailable));
        yield* selectedProfile(executor, current.access.owner, current.app.id, profile).pipe(
          Effect.provideService(CurrentOrganization, current.access),
          Effect.provideService(CurrentUserId, current.access.userId),
          Effect.mapError(dataFailure),
        );
      }
      const deployment = yield* Schema.decodeUnknownEffect(DeploymentId)(payload.deployment).pipe(
        Effect.mapError(unavailable),
      );
      if (deployment !== current.app.activeDeployment) return yield* new UiDeploymentChanged();
      return {
        current,
        input: {
          app: current.app.id,
          deployment,
          profile,
          expectedProfileRevision: payload.expectedProfileRevision,
          name: payload.name,
          input: payload.input,
        },
      };
    });
  const data = (kind: "query" | "mutate", payload: typeof UiOperation.Type) =>
    Effect.gen(function* () {
      const current = yield* CurrentAppUi;
      const { input } = yield* dataInput(payload, current);
      const executor = yield* Effect.flatten(HostedExecutor).pipe(Effect.mapError(unavailable));
      return yield* executor.appData[kind](input).pipe(
        Effect.provideService(CurrentOrganization, current.access),
        Effect.provideService(CurrentAuthorization, fullAuthority),
        Effect.provideService(CurrentUserId, current.access.userId),
        Effect.provideService(CurrentUsage, { source: "app_ui" }),
        Effect.mapError(dataFailure),
      );
    });
  const calls = HttpApiBuilder.group(AppUiApi, "ui", (handlers) =>
    handlers
      .handle("query", ({ payload }) => data("query", payload))
      .handle("mutate", ({ payload }) => data("mutate", payload))
      .handle("subscribe", ({ payload }) =>
        Effect.gen(function* () {
          const current = yield* CurrentAppUi;
          const { input } = yield* dataInput(payload, current);
          const executor = yield* Effect.flatten(HostedExecutor).pipe(Effect.mapError(unavailable));
          const check = authorize.pipe(Effect.flatMap((fresh) => dataInput(payload, fresh)));
          const request = yield* HttpServerRequest.HttpServerRequest;
          const sessions = yield* HostedAppSessions;
          const executorService = yield* HostedExecutor;
          const groups = yield* GroupDatabase;
          // Retain request services, not the handler's parent span or exporter scope.
          // Each streamed check must inherit the current delivery/heartbeat span.
          const access = check.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, request),
            Effect.provideService(HostedAppSessions, sessions),
            Effect.provideService(HostedExecutor, executorService),
            Effect.provideService(GroupDatabase, groups),
          );
          const source = yield* executor.appData
            .subscribe(input)
            .pipe(
              Effect.provideService(CurrentUserId, current.access.userId),
              Effect.provideService(CurrentOrganization, current.access),
              Effect.provideService(CurrentUsage, { source: "app_ui" }),
              Effect.mapError(dataFailure),
            );
          return Stream.merge(
            source.pipe(
              Stream.provideService(CurrentUserId, current.access.userId),
              Stream.provideService(CurrentOrganization, current.access),
              Stream.provideService(GroupDatabase, groups),
              // A re-executed query can notice revocation before the heartbeat.
              // Preserve the product's denial instead of reporting a tool failure.
              Stream.catch((error) =>
                Stream.fromEffect(
                  access.pipe(Effect.flatMap(() => Effect.fail(dataFailure(error)))),
                ),
              ),
              Stream.mapEffect((snapshot) =>
                Effect.gen(function* () {
                  // The first result belongs to this request, which was just authorized.
                  // Every later result, and the heartbeat, checks access again.
                  if (snapshot.revision > 0)
                    yield* access.pipe(Effect.withSpan("app.ui.snapshot.authorize"));
                  return {
                    type: "snapshot" as const,
                    value: snapshot.value,
                    trace: yield* currentTraceContext,
                  };
                }).pipe(Effect.withSpan("app.ui.snapshot.send")),
              ),
            ),
            Stream.tick("5 seconds").pipe(
              Stream.drop(1),
              Stream.mapEffect(() => access.pipe(Effect.withSpan("app.ui.heartbeat.authorize"))),
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
  const watch = authorize.pipe(
    Effect.as(
      HttpServerResponse.text(appWatchScript, {
        contentType: "text/javascript",
        headers: appPrivateHeaders,
      }),
    ),
    htmlFailure,
  );
  const versions = Effect.gen(function* () {
    const current = yield* authorize;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const sessions = yield* HostedAppSessions;
    const executor = yield* HostedExecutor;
    const groups = yield* GroupDatabase;
    // App metadata lives in SQL, across isolates. Reconcile it on each heartbeat
    // with fresh authorization, retaining only this request's service instances.
    const version = authorize.pipe(
      Effect.map(({ app }) => app.activeDeployment),
      Effect.withSpan("app.ui.version.authorize"),
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.provideService(HostedAppSessions, sessions),
      Effect.provideService(HostedExecutor, executor),
      Effect.provideService(GroupDatabase, groups),
    );
    const stream = Stream.make(current.app.activeDeployment).pipe(
      Stream.concat(
        Stream.tick("5 seconds").pipe(
          Stream.drop(1),
          Stream.mapEffect(() => version),
        ),
      ),
      Stream.map((deployment) => `event: version\ndata: ${JSON.stringify({ deployment })}\n\n`),
      Stream.catchTags({
        UiUnauthorized: () => Stream.make("event: revoked\ndata: {}\n\n"),
        UiForbidden: () => Stream.make("event: revoked\ndata: {}\n\n"),
      }),
      Stream.encodeText,
    );
    return HttpServerResponse.stream(stream, {
      contentType: "text/event-stream",
      headers: { ...appPrivateHeaders, "x-accel-buffering": "no" },
    });
  }).pipe(htmlFailure);
  const page = Effect.gen(function* () {
    // The app chose its pages' paths.
    yield* recordRoute("/:page");
    const request = yield* HttpServerRequest.HttpServerRequest;
    const host = addresses.fromHost(request.headers.host);
    if (Option.isSome(host) && anonymousNonNavigation(request, sessionCookie(host.value.origin)))
      return yield* new UiForbidden();
    const resolved = yield* target;
    const navigation =
      request.method === "GET" &&
      (request.headers["sec-fetch-mode"] === "navigate" ||
        request.headers.accept?.includes("text/html"));
    const authorized = yield* authorizeTarget(resolved).pipe(
      Effect.map(Option.some),
      // Only a browser navigation starts sign-in; other requests keep the plain 401.
      Effect.catchTag("UiUnauthorized", (error) =>
        navigation ? Effect.succeed(Option.none()) : Effect.fail(error),
      ),
    );
    if (Option.isNone(authorized)) return yield* beginSignIn(resolved);
    const current = authorized.value;
    const version = yield* deployment(current.app);
    const url = new URL(request.url, current.target.origin);
    /** The dashboard chooser for this app, returning to the page without its profile. */
    const chooser = () =>
      Effect.gen(function* () {
        const back = new URL(url);
        back.searchParams.delete("profile");
        const returnTo = yield* Schema.decodeUnknownEffect(AppReturnPath)(
          back.pathname + back.search,
        ).pipe(Effect.mapError(() => new UiForbidden()));
        const page = new URL(
          `/org/${encodeURIComponent(current.target.slug)}/apps/${current.app.id}/open`,
          addresses.dashboardOrigin,
        );
        page.searchParams.set("returnTo", returnTo);
        return page.href;
      });
    const requested = url.searchParams.get("profile");
    const profile = yield* Schema.decodeUnknownEffect(Schema.optional(ProfileId))(
      requested ?? undefined,
    ).pipe(Effect.mapError(unavailable));
    const executor = yield* Effect.flatten(HostedExecutor).pipe(Effect.mapError(unavailable));
    if (
      profile === undefined &&
      (request.headers["sec-fetch-mode"] === "navigate" ||
        request.headers.accept?.includes("text/html")) &&
      Object.keys(current.app.requirements.accounts).length > 0
    ) {
      const saved = yield* executor.apps.profiles
        .list({ app: current.app.id, owner: current.access.owner, subject: current.access.userId })
        .pipe(Effect.mapError(unavailable));
      const candidates = yield* Effect.filter(
        saved.filter(
          (item) =>
            item.enabled &&
            item.status !== "removed" &&
            item.status !== "removing" &&
            Object.keys(current.app.requirements.accounts).every((slot) =>
              Object.hasOwn(item.accounts, slot),
            ),
        ),
        (item) =>
          checkAccounts(current.access.owner, item.accounts).pipe(
            Effect.as(true),
            Effect.catchTags({
              OrganizationForbidden: () => Effect.succeed(false),
              AccountNotFound: () => Effect.succeed(false),
            }),
            Effect.provideService(CurrentOrganization, current.access),
            Effect.provideService(CurrentUserId, current.access.userId),
            Effect.mapError(unavailable),
          ),
      );
      // A lone profile opens directly only when none of its accounts was rejected.
      const usable = (accounts: SelectedAccounts) =>
        Effect.forEach(accountIds(accounts), (account) =>
          executor.accounts.health({ owner: current.access.owner, account }).pipe(
            Effect.map((health) => !credentialsRejected(health, current.app.id)),
            Effect.catchTag("AccountNotFound", () => Effect.succeed(false)),
            Effect.provideService(CurrentOrganization, current.access),
            Effect.provideService(CurrentUserId, current.access.userId),
            Effect.mapError(unavailable),
          ),
        ).pipe(Effect.map((results) => results.every(Boolean)));
      const only = candidates[0];
      if (candidates.length === 1 && only !== undefined && (yield* usable(only.accounts))) {
        url.searchParams.set("profile", only.id);
        return HttpServerResponse.redirect(url.href, { status: 302, headers: appPrivateHeaders });
      }
      return HttpServerResponse.redirect(yield* chooser(), {
        status: 302,
        headers: appPrivateHeaders,
      });
    }
    const selected =
      profile === undefined
        ? undefined
        : yield* ownProfile(executor, current.access.owner, current.app.id, profile).pipe(
            Effect.provideService(CurrentOrganization, current.access),
            Effect.provideService(CurrentUserId, current.access.userId),
            Effect.mapError(() => new UiForbidden()),
          );
    if (
      selected !== undefined &&
      (!selected.enabled || selected.status === "removing" || selected.status === "removed")
    )
      return yield* new UiForbidden();
    const accountNotice = (profile: ProfileId, accounts: SelectedAccounts) =>
      Effect.gen(function* () {
        const found = yield* Effect.forEach(accountIds(accounts), (account) =>
          requireAccountAccess(account, "use").pipe(
            Effect.andThen(
              Effect.all({
                account: executor.accounts.get({ owner: current.access.owner, account }),
                health: executor.accounts.health({ owner: current.access.owner, account }),
              }),
            ),
            Effect.map((entry) => [[account, entry] as const]),
            Effect.catchTag("AccountNotFound", () => Effect.succeed([])),
            Effect.provideService(CurrentOrganization, current.access),
            Effect.provideService(CurrentUserId, current.access.userId),
            Effect.mapError((error) =>
              error._tag === "OrganizationForbidden" ? new UiForbidden() : unavailable(),
            ),
          ),
        );
        const problems = profileAccountProblems(current.app, accounts, new Map(found.flat()));
        if (problems.length === 0) return undefined;
        const fix = new URL(
          `/org/${encodeURIComponent(current.target.slug)}/apps/${current.app.id}`,
          addresses.dashboardOrigin,
        );
        fix.searchParams.set("view", "accounts");
        fix.searchParams.set("profile", profile);
        return { app: current.app.name, problems, fix: fix.href, choose: yield* chooser() };
      });
    const document = yield* appDocument({
      profile: selected?.id,
      expectedProfileRevision: selected?.revision,
      accounts:
        selected === undefined ? undefined : yield* accountNotice(selected.id, selected.accounts),
      origin: current.target.origin,
      deployment: version.id,
      asset: (path) => assets(version, path),
    });
    yield* recordUsage("app_viewed", { app_id: current.app.id, deployment_id: version.id }).pipe(
      Effect.provideService(CurrentUserId, current.access.userId),
      Effect.provideService(CurrentOrganization, current.access),
      Effect.provideService(CurrentUsage, { source: "app_ui" }),
    );
    return document;
  }).pipe(htmlFailure);
  /** Redeem the dashboard's code with this browser's attempt proof, then return to the page. */
  const callback = Effect.gen(function* () {
    const resolved = yield* target;
    const url = new URL(resolved.request.url, resolved.target.origin);
    const query = yield* Schema.decodeUnknownEffect(AppSignInCallback)({
      request: url.searchParams.get("request"),
      code: url.searchParams.get("code"),
    }).pipe(Effect.mapError(() => new UiUnauthorized()));
    const proof = Schema.decodeUnknownOption(AppSignInCode)(
      resolved.request.cookies[attemptCookie(resolved.target.origin, query.request)],
    );
    if (Option.isNone(proof)) return yield* new UiUnauthorized();
    const sessions = yield* HostedAppSessions;
    const completed = yield* sessions.complete(
      resolved.target,
      query.request,
      query.code,
      proof.value,
    );
    return yield* appRedirect(completed.returnTo).pipe(
      HttpServerResponse.setCookie(
        sessionCookie(resolved.target.origin),
        Redacted.value(completed.token),
        {
          ...cookieOptions(resolved.target.origin),
          maxAge: Math.max(0, completed.expiresAt.getTime() - (yield* Clock.currentTimeMillis)),
        },
      ),
      Effect.flatMap(
        HttpServerResponse.expireCookie(
          attemptCookie(resolved.target.origin, query.request),
          cookieOptions(resolved.target.origin),
        ),
      ),
      Effect.orDie,
    );
  }).pipe(
    Effect.catchTag("UiUnauthorized", () => Effect.succeed(appSignInFailed())),
    htmlFailure,
  );
  const asset = Effect.gen(function* () {
    // The app's build chose its assets' file names.
    yield* recordRoute("/_executor/assets/:deployment/:asset");
    const current = yield* authorize;
    const params = yield* HttpRouter.schemaPathParams(
      Schema.Struct({ deployment: DeploymentId, "*": Schema.NonEmptyString }),
    ).pipe(Effect.mapError(unavailable));
    const version = yield* deployment(current.app, params.deployment);
    return yield* appAsset(yield* assets(version, params["*"]), version.build, params["*"]);
  }).pipe(htmlFailure);
  const originAccess = HttpRouter.middleware((response) =>
    requestOrigin.pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed(failure(error)),
        onSuccess: () => response,
      }),
    ),
  );
  const sessionAccess = HttpRouter.middleware<{ provides: CurrentAppUi }>()((response) =>
    authorize.pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed(failure(error)),
        onSuccess: (current) => response.pipe(Effect.provideService(CurrentAppUi, current)),
      }),
    ),
  );
  const telemetry = (signal: "traces" | "logs") =>
    authorize.pipe(
      Effect.flatMap(({ app }) =>
        receiveBrowserTelemetry(signal, app.activeDeployment ?? undefined),
      ),
      htmlFailure,
    );
  return {
    signIn,
    callback,
    dashboard,
    calls,
    page,
    asset,
    watch,
    versions,
    originAccess,
    sessionAccess,
    telemetry,
  };
};
