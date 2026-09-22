/** Product host for private app pages. Identity comes from the hostname and app cookie, never request input. */
import {
  Deployment,
  DeploymentId,
  AccountRequired,
  OAuthReconnectRequired,
  OwnerId,
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
import { appDocument, appAsset, appWatchScript } from "apps/ui/serving";
import { receiveBrowserTelemetry } from "@executor-js/telemetry/http";
import { currentTraceContext } from "@executor-js/telemetry";
import { Effect, Result, Schema, Stream } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { appSessionCookie } from "../contracts/app-ui.ts";
import type { ServerConfig } from "../contracts/config.ts";
import type { LocalAuth } from "./auth.ts";
import { appRequest } from "./app-auth.ts";
import { appPrivateHeaders as privateHeaders, appSignInPage } from "apps/ui/auth";

const failed = (reason: UiFailed["reason"] = "unavailable") => new UiFailed({ reason });
const UiBuild = Schema.Struct({ id: DeploymentId, build: Deployment.fields.build });

/** Build app handlers and session middleware; the host composition registers their routes. */
export const appUi = (
  executor: Executor,
  storage: ExecutorDatabase,
  runtime: Runtime,
  config: ServerConfig,
  auth: LocalAuth,
) => {
  const native = runtime;
  const db = storage.orm("1.12.0");
  const current = (id: AppId) =>
    executor.apps
      .get({ app: id, owner: OwnerId.make("local") })
      .pipe(Effect.mapError(() => failed()));
  const deployment = (app: Effect.Success<ReturnType<typeof current>>, id = app.activeDeployment) =>
    Effect.gen(function* () {
      const row = yield* db.findFirst("deployments", {
        select: ["id", "build"],
        where: (b) => b.and(b("id", "=", id), b("code", "=", app.code)),
      });
      return yield* Schema.decodeUnknownEffect(UiBuild)(row);
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
      return { app: app.id, deployment: pinned, name: payload.name, input: payload.input };
    });
  const operationFailure = (error: unknown) =>
    Schema.is(AccountRequired)(error) || Schema.is(OAuthReconnectRequired)(error)
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
            Stream.map(({ value }) => ({ type: "snapshot" as const, value })),
            Stream.merge(
              Stream.tick("15 seconds").pipe(Stream.map(() => ({ type: "heartbeat" as const }))),
            ),
            Stream.mapEffect((frame) =>
              Effect.gen(function* () {
                yield* operation(payload).pipe(
                  Effect.withSpan(
                    frame.type === "snapshot"
                      ? "app.ui.snapshot.authorize"
                      : "app.ui.heartbeat.authorize",
                  ),
                );
                if (frame.type === "heartbeat") return frame;
                return { ...frame, trace: yield* currentTraceContext };
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
    const versions = storage.reactivity.subscribe(authorize).pipe(
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
    const app = yield* authorize;
    const params = yield* HttpRouter.schemaPathParams(
      Schema.Struct({ deployment: DeploymentId, "*": Schema.NonEmptyString }),
    ).pipe(Effect.mapError(() => failed()));
    const version = yield* deployment(app, params.deployment);
    const content = yield* readAsset(version.build, params["*"]);
    return yield* appAsset(content, version.build, params["*"]);
  }).pipe(htmlResponse);
  const page = Effect.gen(function* () {
    const app = yield* authorize;
    const { target } = yield* appRequest(config.port);
    const version = yield* deployment(app);
    return yield* appDocument({
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
        // This handler is registered only for the SPA, so APIs and retained assets never return a login document.
        if (request.method === "GET" && navigation) return appSignInPage();
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
