import { localSourceFormatter } from "@executor-js/app-management/source-format";
import { publishedSkillRoutes } from "@executor-js/app-templates/executor";
import {
  drainProvisioning,
  selfHostProvisioningServices,
} from "@executor-js/hosted-server/provisioning";
import { Schedule } from "effect";
import { executorSelfHostApiDocument } from "../contracts/api.ts";
import {
  startScheduleWorker,
  defaultScheduleWorkerOptions,
  ScheduleObservation,
} from "@executor-js/sdk/scheduling";
import { frameworkDocumentation, gitRoutes } from "@executor-js/app-management";
import { hostedAppGitAccess } from "@executor-js/hosted-server/app-management";
/** The route map is shared by native development and the packaged Worker. */
import {
  browserTelemetry,
  requestServices,
  HostedExecutor,
  ScheduledAuthority,
  ScheduleWakeup,
  hostedOAuthCallback,
  clientMetadataDocument,
  clientMetadataDocumentPath,
  clientMetadataSetting,
  hostedWebhookCallback,
  catalogLive,
  hostedMiddlewareLive,
  mcpProtectedResource,
  mcpAuthorizationServer,
  apiChallenge,
  apiProtectedResource,
  lazyHostedApiDocument,
  ProductAnalytics,
} from "@executor-js/hosted-server";
import { recordRequestRejections, requestTiming } from "@executor-js/telemetry/http";
import { appAddresses, hostedAppUi } from "@executor-js/hosted-server/app-ui";
import { appSignInCallbackPath } from "apps/ui/auth";
import { AppUiApi } from "apps/ui/contracts";
import { HttpApiBuilder } from "effect/http-api";
import { appUiBaseUrl } from "../contracts/config.ts";
import { type HostEgress } from "@executor-js/utils/url-policy";
import { Config, Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { withHostPipeline } from "@executor-js/dashboard-start/in-process";
import { selfHostApi } from "./api.ts";
import { selfHostMcp } from "../mcp.ts";
import { SelfHostAuth } from "../auth.ts";
import { selfHostAnalytics } from "./product-analytics.ts";

import type { SourceFile } from "@executor-js/sdk/core";
import type { selfHostExecutorServices } from "./executor-services.ts";
/** Compose the self-host route map without opening a listener; shared by the process entry and HTTP tests. */
export const selfHostRouteMap = <DashboardE, DashboardR>(options: {
  readonly skills: readonly SourceFile[];
  readonly egress: HostEgress;
  readonly executorServices: Layer.Layer<
    Layer.Success<ReturnType<typeof selfHostExecutorServices>>
  >;
  readonly dashboard: Effect.Effect<HttpServerResponse.HttpServerResponse, DashboardE, DashboardR>;
}) =>
  Effect.gen(function* () {
    const { skills, egress, executorServices, dashboard } = options;
    const auth = yield* SelfHostAuth.pipe(Effect.provide(executorServices));
    const analytics = yield* selfHostAnalytics;
    /** Requests and background schedules record through this instance's sink unless it opted out. */
    const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      analytics === undefined
        ? effect
        : effect.pipe(Effect.provideService(ProductAnalytics, analytics.product));
    const scheduler = yield* Effect.gen(function* () {
      const executor = yield* Effect.flatten(HostedExecutor);
      const authorize = yield* ScheduledAuthority;
      const concurrency = yield* Config.Number("EXECUTOR_SCHEDULE_CONCURRENCY").pipe(
        Config.withDefault(defaultScheduleWorkerOptions.concurrency),
      );
      const worker = startScheduleWorker(executor, authorize, {
        ...defaultScheduleWorkerOptions,
        runner: "self-host",
        concurrency,
      });
      // The worker's polling fibers inherit the observer it starts with.
      return yield* analytics === undefined
        ? worker
        : worker.pipe(Effect.provideService(ScheduleObservation, analytics.schedules));
    }).pipe(Effect.provide(executorServices));
    // A span per wake, named as Cloud's coordinator wake, shows which write asked for setup.
    const wake = scheduler.wakeProfiles.pipe(
      Effect.withSpan("schedule.wake", { attributes: { "executor.schedule.wake": "change" } }),
    );
    // Member setup saves profiles and redeploys the default Executor app; it wakes their setup.
    yield* drainProvisioning(selfHostProvisioningServices).pipe(
      Effect.catch(() => Effect.logWarning("Provisioning queue processing failed")),
      Effect.repeat(Schedule.spaced("1 second")),
      Effect.provideService(ScheduleWakeup, wake),
      Effect.provide(executorServices),
      Effect.forkScoped,
    );
    const clientMetadata = yield* clientMetadataSetting(auth.origin);
    const addresses = appAddresses(auth.origin, yield* appUiBaseUrl(auth.origin));
    const appUi = hostedAppUi(addresses);
    const mcp = yield* selfHostMcp.pipe(Effect.provide(HttpServer.layerServices));
    const document = lazyHostedApiDocument(() => executorSelfHostApiDocument(auth.origin));
    const api = selfHostApi(document).pipe(
      Layer.provide(frameworkDocumentation(Effect.succeed(skills))),
      HttpRouter.provideRequest(localSourceFormatter),
      Layer.provide(appUi.dashboard),
      HttpRouter.provideRequest(auth.appSessions),
      HttpRouter.provideRequest(
        catalogLive(document.document, egress, clientMetadata, auth.origin),
      ),
      Layer.provide(hostedMiddlewareLive),
      // Organization middleware reads the product's removal tombstones when it is built.
      Layer.provide(executorServices),
      HttpRouter.provideRequest(executorServices),
      Layer.provide(auth.identity),
      Layer.provide(auth.apiIdentity),
      Layer.provide(auth.mcpIdentity),
    );
    const mcpRoutes = Layer.mergeAll(
      HttpRouter.add("*", "/mcp", mcp.http),
      HttpRouter.add("*", "/org/:organization/mcp", mcp.http),
      HttpRouter.add("GET", "/.well-known/oauth-protected-resource", mcpProtectedResource),
      HttpRouter.add("GET", "/.well-known/oauth-protected-resource/mcp", mcpProtectedResource),
      HttpRouter.add("GET", "/.well-known/oauth-authorization-server", mcpAuthorizationServer),
      HttpRouter.add(
        "GET",
        "/.well-known/oauth-authorization-server/api/auth",
        mcpAuthorizationServer,
      ),
    ).pipe(
      HttpRouter.provideRequest(executorServices),
      HttpRouter.provideRequest(auth.mcpIdentity),
    );
    const authoring = gitRoutes.pipe(
      HttpRouter.provideRequest(hostedAppGitAccess),
      HttpRouter.provideRequest(executorServices),
      Layer.provide(auth.identity),
      Layer.provide(auth.apiIdentity),
    );
    const productRoutes = Layer.mergeAll(
      publishedSkillRoutes(Effect.succeed(skills)),
      authoring,
      api,
      browserTelemetry.pipe(HttpRouter.provideRequest(auth.identity)),
      HttpRouter.add("*", "/api/webhooks/:appId/:subscriptionId", hostedWebhookCallback).pipe(
        HttpRouter.provideRequest(executorServices),
      ),
      HttpRouter.add("*", "/api/auth/*", auth.handler),
      HttpRouter.add("GET", "/api/oauth/callback", hostedOAuthCallback).pipe(
        HttpRouter.provideRequest(auth.identity),
      ),
      HttpRouter.add(
        "GET",
        clientMetadataDocumentPath,
        clientMetadataDocument(clientMetadata),
      ).pipe(HttpRouter.provideRequest(auth.identity)),
      mcpRoutes,
      Layer.mergeAll(
        HttpRouter.add("GET", "/api/mcp/approvals/:requestId", mcp.approvals),
        HttpRouter.add("POST", "/api/mcp/approvals/:requestId", mcp.approvals),
      ).pipe(
        HttpRouter.provideRequest(auth.mcpIdentity),
        HttpRouter.provideRequest(executorServices),
      ),
      Layer.mergeAll(
        HttpRouter.add("GET", "/api", apiChallenge),
        HttpRouter.add("GET", "/.well-known/oauth-protected-resource/api", apiProtectedResource),
      ).pipe(HttpRouter.provideRequest(auth.apiIdentity)),
      // Resolved on the server so opening an app never renders an intermediate dashboard page.
      HttpRouter.add("GET", "/app-auth", appUi.signIn(dashboard)).pipe(
        HttpRouter.provideRequest(auth.appSessions),
        HttpRouter.provideRequest(executorServices),
        HttpRouter.provideRequest(auth.identity),
      ),
      HttpRouter.add("GET", "*", dashboard),
    );
    const notFound = HttpServerResponse.empty({ status: 404 });
    const appServices = requestServices(Layer.mergeAll(auth.appSessions, executorServices));
    const appRoutes = Layer.mergeAll(
      HttpApiBuilder.layer(AppUiApi).pipe(
        Layer.provide(appUi.calls),
        Layer.provide(appUi.sessionAccess.combine(appServices).layer),
      ),
      HttpRouter.add("GET", appSignInCallbackPath, appUi.callback),
      HttpRouter.add("GET", "/_executor/assets/:deployment/*", appUi.asset),
      HttpRouter.add("GET", "/_executor/watch.js", appUi.watch),
      HttpRouter.add("GET", "/_executor/version", appUi.versions),
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
      HttpRouter.provideRequest(executorServices),
    );
    const apps = yield* HttpRouter.toHttpEffect(appRoutes).pipe(
      Effect.provideService(Layer.CurrentMemoMap, yield* Layer.makeMemoMap),
    );
    const product = yield* HttpRouter.toHttpEffect(productRoutes).pipe(
      Effect.provideService(Layer.CurrentMemoMap, yield* Layer.makeMemoMap),
      Effect.map((handler) => handler.pipe(Effect.provideService(ScheduleWakeup, wake))),
    );
    const routes = HttpRouter.add(
      "*",
      "*",
      // Server-rendered pages read the product API through this same dispatch, in-process.
      withHostPipeline(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (Option.isSome(addresses.fromHost(request.headers.host)))
            return yield* observed(apps.pipe(requestTiming));
          if (addresses.ownsHost(request.headers.host)) return notFound;
          return yield* observed(product);
        }).pipe(recordRequestRejections),
      ),
    );
    return routes;
  });
