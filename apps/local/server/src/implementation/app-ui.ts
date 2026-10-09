import { ProfileId, ProfileConflict } from "@executor-js/sdk/core";
/** Product host for private app pages. Identity comes from the hostname and app cookie, never request input. */
import {
  Deployment,
  DeploymentId,
  AccountRequired,
  credentialsRejected,
  profileAccountProblems,
  OAuthReconnectRequired,
  OwnerId,
  type App,
  type AppId,
  type ExecutorDatabase,
  type SelectedAccounts,
  type Executor,
  type Runtime,
} from "@executor-js/sdk/core";
import {
  AppUiApi,
  UiDeploymentChanged,
  UiFailed,
  UiForbidden,
  UiUnauthorized,
  type UiOperation,
} from "apps/ui/contracts";
import { appDocument, appAsset, appWatchScript } from "apps/ui/serving";
import { receiveBrowserTelemetry } from "@executor-js/telemetry/http";
import { currentTraceContext, recordRoute } from "@executor-js/telemetry";
import { Effect, Result, Schema, Stream } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { appSessionCookie } from "../contracts/app-ui.ts";
import type { ServerConfig } from "../contracts/config.ts";
import type { LocalAuth } from "./auth.ts";
import { appRequest } from "./app-auth.ts";
import { AppReturnPath, appPrivateHeaders as privateHeaders } from "apps/ui/auth";

const failed = (reason: UiFailed["reason"] = "unavailable") => new UiFailed({ reason });
const UiBuild = Schema.Struct({ id: DeploymentId, build: Deployment.fields.build });
const accountIds = (accounts: SelectedAccounts) =>
  Object.values(accounts).flatMap((value) => (typeof value === "string" ? [value] : value));

/** Build app handlers and session middleware; the host composition registers their routes. */
export const appUi = (
  executor: Executor,
  reactivity: ExecutorDatabase["reactivity"],
  runtime: Runtime,
  config: ServerConfig,
  auth: LocalAuth,
  beginSignIn: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    UiForbidden | UiFailed,
    HttpServerRequest.HttpServerRequest
  >,
) => {
  const native = runtime;
  const current = (id: AppId) =>
    executor.apps
      .get({ app: id, owner: OwnerId.make("local") })
      .pipe(Effect.mapError(() => failed()));
  const deployment = (app: Effect.Success<ReturnType<typeof current>>, id = app.activeDeployment) =>
    Effect.gen(function* () {
      if (id === null) return yield* failed();
      const metadata = yield* executor.apps.deployment({
        app: app.id,
        owner: OwnerId.make("local"),
        deployment: id,
      });
      return UiBuild.make({ id: metadata.id, build: metadata.build });
    }).pipe(Effect.mapError(() => failed()));
  const authorize = Effect.gen(function* () {
    const { target, request } = yield* appRequest(config.port);
    const valid = yield* auth
      .validApp(target, request.cookies[appSessionCookie(config.port)])
      .pipe(Effect.mapError(() => failed()));
    if (!valid) return yield* new UiUnauthorized();
    return yield* current(target.app);
  });
  const operation = (payload: typeof UiOperation.Type) =>
    Effect.gen(function* () {
      const app = yield* authorize;
      const pinned = yield* Schema.decodeUnknownEffect(DeploymentId)(payload.deployment).pipe(
        Effect.mapError(() => failed()),
      );
      if (app.activeDeployment !== pinned) return yield* new UiDeploymentChanged();
      const profile = yield* Schema.decodeUnknownEffect(Schema.optional(ProfileId))(
        payload.profile,
      ).pipe(Effect.mapError(() => new UiForbidden()));
      return {
        app: app.id,
        deployment: pinned,
        profile,
        expectedProfileRevision: payload.expectedProfileRevision,
        name: payload.name,
        input: payload.input,
      };
    });
  const operationFailure = (error: unknown) =>
    Schema.is(ProfileConflict)(error) && error.reason === "revision"
      ? new UiDeploymentChanged()
      : Schema.is(AccountRequired)(error) || Schema.is(OAuthReconnectRequired)(error)
        ? failed("account_required")
        : failed("operation_failed");
  const safeOperation = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError(operationFailure));
  const uiHandlers = HttpApiBuilder.group(AppUiApi, "ui", (handlers) =>
    handlers
      .handle("query", ({ payload }) =>
        operation(payload).pipe(
          Effect.flatMap((input) => safeOperation(executor.appData.query(input))),
        ),
      )
      .handle("mutate", ({ payload }) =>
        operation(payload).pipe(
          Effect.flatMap((input) => safeOperation(executor.appData.mutate(input))),
        ),
      )
      .handle("subscribe", ({ payload }) =>
        Effect.gen(function* () {
          const input = yield* operation(payload);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const source = yield* safeOperation(executor.appData.subscribe(input));
          return source.pipe(
            Stream.mapError(operationFailure),
            Stream.map(({ value, revision }) => ({ type: "snapshot" as const, value, revision })),
            Stream.merge(
              Stream.tick("15 seconds").pipe(Stream.map(() => ({ type: "heartbeat" as const }))),
            ),
            Stream.mapEffect((frame) =>
              Effect.gen(function* () {
                // The first result belongs to this request, which was just authorized.
                if (frame.type === "heartbeat" || frame.revision > 0)
                  yield* operation(payload).pipe(
                    Effect.withSpan(
                      frame.type === "snapshot"
                        ? "app.ui.snapshot.authorize"
                        : "app.ui.heartbeat.authorize",
                    ),
                  );
                if (frame.type === "heartbeat") return frame;
                return { type: frame.type, value: frame.value, trace: yield* currentTraceContext };
              }).pipe(
                Effect.withSpan(
                  frame.type === "snapshot" ? "app.ui.snapshot.send" : "app.ui.heartbeat",
                ),
              ),
            ),
            Stream.provideService(HttpServerRequest.HttpServerRequest, request),
          );
        }),
      ),
  );
  const readAsset = (build: Deployment["build"], path: string) =>
    native.asset === undefined
      ? Effect.succeed(undefined)
      : native.asset({ build, path }).pipe(Effect.mapError(() => failed()));
  const htmlResponse = Effect.catchTags({
    UiUnauthorized: () =>
      Effect.succeed(
        HttpServerResponse.text("Sign in to this app to continue.", {
          status: 401,
          headers: privateHeaders,
        }),
      ),
    UiForbidden: () =>
      Effect.succeed(
        HttpServerResponse.text("App unavailable.", { status: 403, headers: privateHeaders }),
      ),
    UiFailed: () =>
      Effect.succeed(
        HttpServerResponse.text("App unavailable.", { status: 404, headers: privateHeaders }),
      ),
  });
  const versions = Effect.gen(function* () {
    yield* authorize;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const versions = reactivity.subscribe(authorize).pipe(
      Stream.map(({ value }) => value.activeDeployment),
      Stream.changes,
      Stream.map((deployment) => `event: version\ndata: ${JSON.stringify({ deployment })}\n\n`),
      Stream.merge(Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))),
      Stream.mapEffect((event) => authorize.pipe(Effect.as(event))),
      Stream.catch(() => Stream.make("event: revoked\ndata: {}\n\n")),
      Stream.encodeText,
      Stream.provideService(HttpServerRequest.HttpServerRequest, request),
    );
    return HttpServerResponse.stream(versions, {
      contentType: "text/event-stream",
      headers: { ...privateHeaders, "x-accel-buffering": "no" },
    });
  }).pipe(htmlResponse);
  const asset = Effect.gen(function* () {
    // The app's build chose its assets' file names.
    yield* recordRoute("/_executor/assets/:deployment/:asset");
    const app = yield* authorize;
    const params = yield* HttpRouter.schemaPathParams(
      Schema.Struct({ deployment: DeploymentId, "*": Schema.NonEmptyString }),
    ).pipe(Effect.mapError(() => failed()));
    const version = yield* deployment(app, params.deployment);
    const content = yield* readAsset(version.build, params["*"]);
    return yield* appAsset(content, version.build, params["*"]);
  }).pipe(htmlResponse);
  const dashboard = config.browserOrigin ?? `http://127.0.0.1:${config.port}`;
  /** The dashboard chooser for this app, returning to the page without its profile. */
  const chooser = (app: AppId, page: URL) =>
    Effect.gen(function* () {
      const back = new URL(page);
      back.searchParams.delete("profile");
      const returnTo = yield* Schema.decodeUnknownEffect(AppReturnPath)(
        back.pathname + back.search,
      ).pipe(Effect.mapError(() => new UiForbidden()));
      const url = new URL(`/apps/${app}/open`, dashboard);
      url.searchParams.set("returnTo", returnTo);
      return url.href;
    });
  /** Problems with the page profile's accounts, checked before the app renders. */
  const accountNotice = (app: App, profile: ProfileId, accounts: SelectedAccounts, page: URL) =>
    Effect.gen(function* () {
      const found = yield* Effect.forEach(accountIds(accounts), (account) =>
        Effect.all({
          account: executor.accounts.get({ account }),
          health: executor.accounts.health({ account }),
        }).pipe(
          Effect.map((entry) => [[account, entry] as const]),
          Effect.catchTag("AccountNotFound", () => Effect.succeed([])),
          Effect.mapError(() => failed()),
        ),
      );
      const problems = profileAccountProblems(app, accounts, new Map(found.flat()));
      if (problems.length === 0) return undefined;
      const fix = new URL(`/apps/${app.id}`, dashboard);
      fix.searchParams.set("view", "accounts");
      fix.searchParams.set("profile", profile);
      return { app: app.name, problems, fix: fix.href, choose: yield* chooser(app.id, page) };
    });
  const page = Effect.gen(function* () {
    // The app chose its pages' paths.
    yield* recordRoute("/:page");
    const app = yield* authorize;
    const { target } = yield* appRequest(config.port);
    const version = yield* deployment(app);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, target.origin);
    const requested = url.searchParams.get("profile");
    const profile = yield* Schema.decodeUnknownEffect(Schema.optional(ProfileId))(
      requested ?? undefined,
    ).pipe(Effect.mapError(() => new UiForbidden()));
    if (
      profile === undefined &&
      (request.headers["sec-fetch-mode"] === "navigate" ||
        request.headers.accept?.includes("text/html")) &&
      Object.keys(app.requirements.accounts).length > 0
    ) {
      const saved = yield* executor.apps.profiles
        .list({ app: app.id, owner: app.owner, subject: "local" })
        .pipe(Effect.mapError(() => failed()));
      const candidates = saved.filter(
        (item) =>
          item.enabled &&
          item.status !== "removed" &&
          item.status !== "removing" &&
          Object.keys(app.requirements.accounts).every((slot) =>
            Object.hasOwn(item.accounts, slot),
          ),
      );
      // A lone profile opens directly only when its accounts exist and none was rejected.
      const usable = (accounts: SelectedAccounts) =>
        Effect.forEach(accountIds(accounts), (account) =>
          executor.accounts.health({ account }).pipe(
            Effect.map((health) => !credentialsRejected(health, app.id)),
            Effect.catchTag("AccountNotFound", () => Effect.succeed(false)),
            Effect.mapError(() => failed()),
          ),
        ).pipe(Effect.map((results) => results.every(Boolean)));
      const only = candidates[0];
      if (candidates.length === 1 && only !== undefined && (yield* usable(only.accounts))) {
        url.searchParams.set("profile", only.id);
        return HttpServerResponse.redirect(url.href, { status: 302, headers: privateHeaders });
      }
      return HttpServerResponse.redirect(yield* chooser(app.id, url), {
        status: 302,
        headers: privateHeaders,
      });
    }
    const selected =
      profile === undefined
        ? undefined
        : yield* executor.apps.profiles
            .get({ app: app.id, profile })
            .pipe(Effect.mapError(() => new UiForbidden()));
    if (
      selected !== undefined &&
      (!selected.enabled ||
        selected.subject !== "local" ||
        selected.status === "removed" ||
        selected.status === "removing")
    )
      return yield* new UiForbidden();
    return yield* appDocument({
      profile: selected?.id,
      expectedProfileRevision: selected?.revision,
      accounts:
        selected === undefined
          ? undefined
          : yield* accountNotice(app, selected.id, selected.accounts, url),
      origin: target.origin,
      deployment: version.id,
      asset: (path) => readAsset(version.build, path),
    });
  }).pipe(
    Effect.catchTag("UiUnauthorized", (error) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const navigation =
          request.headers["sec-fetch-mode"] === "navigate" ||
          request.headers.accept?.includes("text/html");
        // This handler is registered only for the SPA, so APIs and retained assets never start sign-in.
        if (request.method === "GET" && navigation) return yield* beginSignIn;
        return yield* error;
      }),
    ),
    htmlResponse,
  );
  const watch = authorize.pipe(
    Effect.as(
      HttpServerResponse.text(appWatchScript, {
        contentType: "text/javascript",
        headers: privateHeaders,
      }),
    ),
    htmlResponse,
  );
  const authenticated = HttpRouter.middleware((response) =>
    authorize.pipe(
      Effect.result,
      Effect.flatMap((access) =>
        Result.isFailure(access)
          ? Effect.succeed(
              HttpServerResponse.jsonUnsafe(access.failure, {
                status: Schema.is(UiForbidden)(access.failure)
                  ? 403
                  : Schema.is(UiUnauthorized)(access.failure)
                    ? 401
                    : 422,
                headers: privateHeaders,
              }),
            )
          : response,
      ),
    ),
  );
  const telemetry = (signal: "traces" | "logs") =>
    authorize.pipe(
      Effect.flatMap((app) =>
        receiveBrowserTelemetry(
          signal,
          app.activeDeployment === null ? undefined : app.activeDeployment,
        ),
      ),
      htmlResponse,
    );
  return { api: uiHandlers, page, asset, versions, watch, authenticated, telemetry };
};
