/** Product host for private app pages. Identity comes from the hostname and app cookie, never request input. */
import {
  Deployment,
  DeploymentId,
  AccountNotFound,
  AccountRequired,
  AccountSelectionInvalid,
  accountProblems,
  invocationEntries,
  type AppAccounts,
  OAuthReconnectRequired,
  type AppId,
  type ExecutorDatabase,
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
import { appDocument, appAsset, appWatchScript, assetPath, storedAppFile } from "apps/ui/serving";
import { receiveBrowserTelemetry } from "@executor-js/telemetry/http";
import { currentTraceContext, recordRoute } from "@executor-js/telemetry";
import { Effect, Option, Result, Schema, Stream } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { localOwner } from "./owners.ts";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { appSessionCookie } from "../contracts/app-ui.ts";
import type { ServerConfig } from "../contracts/config.ts";
import type { LocalAuth } from "./auth.ts";
import { appRequest } from "./app-auth.ts";
import { appPrivateHeaders as privateHeaders } from "apps/ui/auth";
import type { SqlClient } from "effect/sql";
import { callerAccounts } from "./app-accounts.ts";

const failed = (reason: UiFailed["reason"] = "unavailable") => new UiFailed({ reason });
const UiBuild = Schema.Struct({ id: DeploymentId, build: Deployment.fields.build });
/** Every account an operation's accounts use, in both scopes. */
const accountIds = (accounts: AppAccounts) => [
  ...new Set(invocationEntries(accounts).flatMap(([, ids]) => ids)),
];

/** Build app handlers and session middleware; the host composition registers their routes. */
export const appUi = (
  executor: Executor,
  sql: SqlClient.SqlClient,
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
    executor.apps.get({ app: id, owner: localOwner }).pipe(Effect.mapError(() => failed()));
  const deployment = (app: Effect.Success<ReturnType<typeof current>>, id = app.activeDeployment) =>
    Effect.gen(function* () {
      if (id === null) return yield* failed();
      const metadata = yield* executor.apps.deployment({
        app: app.id,
        owner: localOwner,
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
  const operationFailure = (error: unknown) =>
    Schema.is(AccountRequired)(error) ||
    Schema.is(AccountNotFound)(error) ||
    Schema.is(AccountSelectionInvalid)(error) ||
    Schema.is(OAuthReconnectRequired)(error)
      ? failed("account_required")
      : failed("operation_failed");
  /** Each call runs with the accounts linked to the app now. */
  const operation = (payload: typeof UiOperation.Type) =>
    Effect.gen(function* () {
      const app = yield* authorize;
      const pinned = yield* Schema.decodeUnknownEffect(DeploymentId)(payload.deployment).pipe(
        Effect.mapError(() => failed()),
      );
      if (app.activeDeployment !== pinned) return yield* new UiDeploymentChanged();
      const accounts = yield* callerAccounts(sql, executor, app).pipe(
        Effect.mapError(operationFailure),
      );
      return {
        app: app.id,
        deployment: pinned,
        accounts,
        name: payload.name,
        input: payload.input,
      };
    });
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
      : native.asset({ build, path }).pipe(
          Effect.mapError(() => failed()),
          Effect.map((asset) =>
            asset === undefined || "body" in asset
              ? asset
              : storedAppFile(
                  { contentType: asset.contentType, size: asset.size, etag: asset.object },
                  (range) => asset.read(range).pipe(Effect.map((body) => Option.some({ body }))),
                ),
          ),
        );
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
    const path = Option.getOrUndefined(assetPath(params["*"]));
    if (path === undefined) return yield* appAsset(undefined, version.build, params["*"]);
    return yield* appAsset(yield* readAsset(version.build, path), version.build, path);
  }).pipe(htmlResponse);
  const dashboard = config.browserOrigin ?? `http://127.0.0.1:${config.port}`;
  const page = Effect.gen(function* () {
    // The app chose its pages' paths.
    yield* recordRoute("/:page");
    const app = yield* authorize;
    const { target } = yield* appRequest(config.port);
    const version = yield* deployment(app);
    const fix = new URL(`/apps/${app.id}`, dashboard);
    fix.searchParams.set("view", "accounts");
    // The page runs with the app's linked accounts and the linked ones; a plain requirement with
    // none shows what to connect.
    const resolution = yield* callerAccounts(sql, executor, app).pipe(
      Effect.map((accounts) => ({ kind: "resolved" as const, accounts })),
      Effect.catchTag("AccountRequired", (error) =>
        Effect.succeed({ kind: "missing" as const, slot: error.slot }),
      ),
      Effect.mapError(() => failed()),
    );
    const accountNotice = Effect.gen(function* () {
      if (resolution.kind === "missing") {
        const requirement = app.requirements.accounts[resolution.slot];
        if (requirement === undefined) return yield* failed();
        return {
          app: app.name,
          problems: [{ provider: requirement.definition.name, reason: "missing" as const }],
          fix: fix.href,
        };
      }
      const used = accountIds(resolution.accounts);
      if (used.length === 0) return undefined;
      const found = yield* Effect.forEach(used, (account) =>
        Effect.all({
          account: executor.accounts.get({ account }),
          health: executor.accounts.health({ account, apps: [app.id] }),
        }).pipe(
          Effect.map((entry) => [[account, entry] as const]),
          Effect.catchTag("AccountNotFound", () => Effect.succeed([])),
          Effect.mapError(() => failed()),
        ),
      );
      const problems = accountProblems(app, resolution.accounts, new Map(found.flat()));
      if (problems.length === 0) return undefined;
      return { app: app.name, problems, fix: fix.href };
    });
    return yield* appDocument({
      // The page names the user requirements' accounts, as hosted does; the app's stay with it.
      accountIds: resolution.kind === "resolved" ? resolution.accounts.user : undefined,
      accounts: yield* accountNotice,
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
