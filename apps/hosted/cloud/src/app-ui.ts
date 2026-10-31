import { requestServices } from "@executor-js/hosted-server";
import { previewLifetime } from "./infrastructure/test-stage-expiry.ts";
/** Private app-origin entry point. Dashboard assets and management APIs are never mounted here. */
import {
  appUiAddressScheme,
  appUiEmbedded,
  hostedAppUi,
  appAddresses,
} from "@executor-js/hosted-server/app-ui";
import { appPrivateHeaders, appSignInCallbackPath } from "apps/ui/auth";
import { AppUiApi } from "apps/ui/contracts";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Cloudflare from "alchemy/Cloudflare";
import { Cause, Config, Effect, Layer, Option, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HttpRouter, HttpServer, HttpServerError, HttpServerResponse } from "effect/http";
import { cloudAppUiBase, cloudAppUiPort, cloudAppUiRoute } from "./contracts/app-ui.ts";
import { recordRequestRejections, requestTiming } from "@executor-js/telemetry/http";
// Failures are logged as telemetry records them: tags and fixed sentences, never values.
import { recordedCause } from "@executor-js/telemetry/recorded-failure";
import { cloudSentry } from "./implementation/error-reporting.ts";
import { cloudAnalytics } from "./implementation/product-analytics.ts";
import { postHogBindings } from "./infrastructure/posthog.ts";
import { cloudAppSessions } from "./infrastructure/app-sessions.ts";
import { cloudAuthDatabase } from "./infrastructure/auth-database.ts";
import { cloudServingProduct } from "./infrastructure/serving-product.ts";
import { sentryBindings } from "./infrastructure/sentry.ts";
import { cloudHosts } from "./infrastructure/stage.ts";
import { appDataSupervisors } from "./infrastructure/app-data.ts";
import { Api } from "./infrastructure/api-worker.ts";
import {
  cloudObservability,
  cloudTelemetry,
  telemetryBindings,
} from "./infrastructure/telemetry.ts";

import { workerBuild } from "./infrastructure/worker-build.ts";

/** Where a config read failed: key paths and issue kinds only, never the value it read. */
const configIssues = (error: unknown): string[] => {
  if (!Predicate.hasProperty(error, "_tag") || error._tag !== "ConfigError") return [];
  const cause = Predicate.hasProperty(error, "cause") ? error.cause : undefined;
  if (!Predicate.hasProperty(cause, "issue")) return ["(source unavailable)"];
  const found: string[] = [];
  const walk = (issue: unknown, path: readonly PropertyKey[]): void => {
    if (!Predicate.hasProperty(issue, "_tag") || typeof issue._tag !== "string") return;
    if (
      issue._tag === "Pointer" &&
      Predicate.hasProperty(issue, "path") &&
      Array.isArray(issue.path)
    )
      walk(Predicate.hasProperty(issue, "issue") ? issue.issue : undefined, [
        ...path,
        ...issue.path,
      ]);
    else if (Predicate.hasProperty(issue, "issue")) walk(issue.issue, path);
    else if (
      Predicate.hasProperty(issue, "issues") &&
      Array.isArray(issue.issues) &&
      issue.issues.length > 0
    )
      for (const nested of issue.issues) walk(nested, path);
    else found.push(`${path.map(String).join(".") || "(root)"}: ${issue._tag}`);
  };
  try {
    walk(cause.issue, []);
  } catch {
    // An unexpected issue shape must not turn logging into another failure.
    return ["(unreadable)"];
  }
  return found;
};

/** Log a failure as telemetry records it, plus the config keys a ConfigError names. */
const logFailure = (cause: Cause.Cause<unknown>) => {
  const keys = cause.reasons.flatMap((reason) =>
    Cause.isFailReason(reason)
      ? configIssues(reason.error)
      : Cause.isDieReason(reason)
        ? configIssues(reason.defect)
        : [],
  );
  return Effect.logError(
    Cause.pretty(recordedCause(cause)) + (keys.length ? `\nconfig: ${keys.join("; ")}` : ""),
  );
};

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
      build: workerBuild("app-pages"),
      ...(yield* cloudObservability),
      env: {
        ...(yield* postHogBindings).env,
        AppWorkflows: Cloudflare.Workflow("AppWorkflows", {
          className: "AppWorkflows",
          scriptName: (yield* Api).workerName,
        }),
        ...(yield* telemetryBindings),
        ...(yield* sentryBindings).env,
        EXECUTOR_APP_UI_ADDRESS_SCHEME: yield* appUiAddressScheme,
        EXECUTOR_APP_UI_EMBEDDED: String(yield* appUiEmbedded),
      },
      compatibility: {
        date: "2026-09-08",
        flags: ["nodejs_compat", "global_fetch_strictly_public", "no_brotli_content_encoding"],
      },
      ...(dev
        ? {}
        : Option.match(placementRegion, {
            onNone: () => ({}),
            onSome: (region) => ({ placement: { region } }),
          })),
      ...(dev ||
      !(yield* Config.Boolean("EXECUTOR_APP_UI_MANAGED_ROUTE").pipe(Config.withDefault(true)))
        ? {}
        : { routes: [{ pattern: yield* cloudAppUiRoute.pipe(Effect.orDie) }] }),
      dev: { host: "127.0.0.1", port: yield* cloudAppUiPort.pipe(Effect.orDie), strictPort: true },
    };
  }).pipe(Effect.tapCause(logFailure)),
  Effect.gen(function* () {
    const reportErrors = yield* cloudSentry;
    const analytics = yield* cloudAnalytics;
    const appSessions = yield* cloudAppSessions;
    const executor = yield* cloudServingProduct(yield* appDataSupervisors);
    const base = yield* cloudAppUiBase.pipe(Effect.orDie);
    // App pages send sign-in to the dashboard, on the browser origin.
    const appUi = hostedAppUi(
      appAddresses(
        (yield* cloudHosts.pipe(Effect.orDie)).browser,
        base,
        yield* appUiAddressScheme.pipe(Effect.orDie),
        yield* appUiEmbedded.pipe(Effect.orDie),
      ),
    );
    const services = requestServices(Layer.mergeAll(appSessions, executor));
    const notFound = HttpServerResponse.empty({ status: 404 });
    const protectedRoutes = Layer.mergeAll(
      HttpRouter.add("GET", appSignInCallbackPath, appUi.callback),
      HttpRouter.add("GET", "/_executor/assets/:version/*", appUi.asset),
      HttpRouter.add("GET", "/_executor/watch.js", appUi.watch),
      HttpRouter.add("GET", "/_executor/version", appUi.versions),
      HttpRouter.add("POST", "/_executor/api/telemetry/traces", appUi.telemetry("traces")),
      HttpRouter.add("POST", "/_executor/api/telemetry/logs", appUi.telemetry("logs")),
      HttpRouter.add("GET", "*", appUi.page),
    ).pipe(Layer.provide(services.layer));
    const routes = Layer.mergeAll(
      protectedRoutes,
      HttpApiBuilder.layer(AppUiApi).pipe(
        Layer.provide(appUi.calls),
        Layer.provide(appUi.sessionAccess.combine(services).layer),
      ),
      HttpRouter.add("GET", "/_executor/*", notFound),
      HttpRouter.add("GET", "/api/*", notFound),
      HttpRouter.add("GET", "/mcp/*", notFound),
      HttpRouter.add("GET", "/.well-known/*", notFound),
    ).pipe(Layer.provide(appUi.originAccess.layer));
    const handle = yield* routes.pipe(
      Layer.provide(HttpServer.layerServices),
      HttpRouter.toHttpEffect,
      Effect.provideService(Layer.CurrentMemoMap, yield* Layer.makeMemoMap),
    );
    const lifetime = yield* previewLifetime;
    return {
      fetch: appUi.frameResponse(handle).pipe(
        // Every GET reaches the page route, so an unmatched route is another method. Not found,
        // as on self-host.
        Effect.catchIf(
          (error): error is HttpServerError.HttpServerError =>
            HttpServerError.isHttpServerError(error) && error.reason._tag === "RouteNotFound",
          () =>
            Effect.succeed(HttpServerResponse.empty({ status: 404, headers: appPrivateHeaders })),
        ),
        analytics.wrap,
        recordRequestRejections,
        reportErrors,
        Effect.tapCause(logFailure),
        Effect.catchCause((cause) => {
          const error = Option.getOrUndefined(Cause.findErrorOption(cause));
          if (error !== undefined && HttpServerError.isHttpServerError(error))
            return Effect.fail(error);
          return Effect.succeed(
            HttpServerResponse.empty({ status: 500, headers: appPrivateHeaders }),
          );
        }),
        requestTiming,
        lifetime.http,
      ),
    };
  }).pipe(
    Effect.provide(Layer.mergeAll(cloudAuthDatabase, cloudTelemetry)),
    Effect.tapCause(logFailure),
  ),
) {}
