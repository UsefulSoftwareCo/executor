import { cloudGroupDatabase } from "./infrastructure/group-database.ts";
/** Private app-origin entry point. Dashboard assets and management APIs are never mounted here. */
import { hostedAppUi, appAddresses } from "@executor-js/hosted-server/app-ui";
import { AppSignInApi, appSignInPage, appSignInScript, appPrivateHeaders } from "apps/ui/auth";
import { AppUiApi } from "apps/ui/contracts";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect, Layer, Option } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { cloudAppUiBase, cloudAppUiPort, cloudAppUiRoute } from "./contracts/app-ui.ts";
import { requestTiming } from "@executor-js/telemetry/http";
import { cloudSentry } from "./implementation/error-reporting.ts";
import { cloudAuth } from "./infrastructure/auth.ts";
import { cloudAuthDatabase } from "./infrastructure/auth-database.ts";
import { cloudEmail } from "./infrastructure/email.ts";
import { cloudExecutor } from "./infrastructure/executor.ts";
import { sentryBindings } from "./infrastructure/sentry.ts";
import { billingBindings } from "./infrastructure/billing.ts";
import { AppDataSupervisor } from "./infrastructure/app-data.ts";
import { Api } from "./main.ts";
import {
  cloudObservability,
  cloudTelemetry,
  telemetryBindings,
} from "./infrastructure/telemetry.ts";

/** A dedicated native Worker guarantees that every private HTML/JS/CSS request passes app authentication. */
export default class AppPages extends Cloudflare.Worker<AppPages>()(
  "AppPages",
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };
    const { dev } = yield* AlchemyContext;
    const base = yield* cloudAppUiBase.pipe(Effect.orDie);
    const placementRegion = yield* Config.NonEmptyString("CLOUD_PLACEMENT_REGION").pipe(
      Config.option,
    );
    if (base === undefined)
      return yield* Effect.die(new Error("App UI requires EXECUTOR_APP_UI_BASE_URL"));
    return {
      main: import.meta.url,
      ...(yield* cloudObservability),
      env: {
        AppWorkflows: Cloudflare.Workflow("AppWorkflows", {
          className: "AppWorkflows",
          scriptName: (yield* Api).workerName,
        }),
        ...(yield* telemetryBindings),
        ...(yield* billingBindings),
        ...(yield* sentryBindings).env,
      },
      compatibility: {
        date: "2026-09-08",
        flags: ["nodejs_compat", "global_fetch_strictly_public"],
      },
      ...(dev
        ? {}
        : Option.match(placementRegion, {
            onNone: () => ({}),
            onSome: (region) => ({ placement: { region } }),
          })),
      ...(dev ? {} : { routes: [{ pattern: yield* cloudAppUiRoute.pipe(Effect.orDie) }] }),
      dev: { host: "127.0.0.1", port: yield* cloudAppUiPort.pipe(Effect.orDie), strictPort: true },
    };
  }),
  Effect.gen(function* () {
    const reportErrors = yield* cloudSentry;
    const email = yield* cloudEmail.pipe(Effect.orDie);
    const auth = yield* cloudAuth(email.send);
    const executor = yield* cloudExecutor(yield* AppDataSupervisor.from(Api));
    const policy = yield* cloudGroupDatabase;
    const base = yield* cloudAppUiBase.pipe(Effect.orDie);
    const appUi = hostedAppUi(appAddresses(auth.origin, base));
    const notFound = HttpServerResponse.empty({ status: 404 });
    const routes = Layer.mergeAll(
      HttpApiBuilder.layer(AppSignInApi).pipe(Layer.provide(appUi.appAuth)),
      HttpApiBuilder.layer(AppUiApi).pipe(
        Layer.provide(appUi.calls),
        Layer.provide(
          appUi.sessionAccess.layer.pipe(
            Layer.provide(auth.appSessions),
            Layer.provide(executor),
            Layer.provide(policy),
          ),
        ),
      ),
      HttpRouter.add("GET", "/_executor/auth/callback", appSignInPage()),
      HttpRouter.add("GET", "/_executor/auth/browser.js", appSignInScript()),
      HttpRouter.add("GET", "/_executor/assets/:deployment/*", appUi.asset),
      HttpRouter.add("POST", "/_executor/api/telemetry/traces", appUi.telemetry("traces")),
      HttpRouter.add("POST", "/_executor/api/telemetry/logs", appUi.telemetry("logs")),
      HttpRouter.add("GET", "/_executor/*", notFound),
      HttpRouter.add("GET", "/api/*", notFound),
      HttpRouter.add("GET", "/mcp/*", notFound),
      HttpRouter.add("GET", "/.well-known/*", notFound),
      HttpRouter.add("GET", "*", appUi.page),
    ).pipe(
      Layer.provide(appUi.originAccess.layer),
      HttpRouter.provideRequest(auth.appSessions),
      HttpRouter.provideRequest(executor),
      HttpRouter.provideRequest(policy),
    );
    return {
      fetch: routes.pipe(
        Layer.provide(HttpServer.layerServices),
        HttpRouter.toHttpEffect,
        Effect.flatten,
        reportErrors,
        Effect.catch(() =>
          Effect.succeed(
            HttpServerResponse.text("App unavailable.", {
              status: 503,
              headers: appPrivateHeaders,
            }),
          ),
        ),
        requestTiming,
      ),
    };
  }).pipe(Effect.provide(Layer.mergeAll(cloudAuthDatabase, cloudTelemetry))),
) {}
