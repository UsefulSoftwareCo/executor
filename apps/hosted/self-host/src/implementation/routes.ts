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
  authSettings,
  hostedWebhookCallback,
  catalogLive,
  hostedMiddlewareLive,
  mcpProtectedResource,
  mcpWhoami,
  mcpWhoamiPath,
  mcpAuthorizationServer,
  apiChallenge,
  apiProtectedResource,
  desktopProtectedResource,
  lazyHostedApiDocument,
  ProductAnalytics,
} from "@executor-js/hosted-server";
import { recordRequestRejections, requestTiming } from "@executor-js/telemetry/http";
import { appAddresses, appLaunchPath, hostedAppUi } from "@executor-js/hosted-server/app-ui";
import { appSignInCallbackPath } from "apps/ui/auth";
import {
  AppUiApi,
  appIconRoute,
  appMenuBarRoute,
  executorServerIdentityPath,
} from "apps/ui/contracts";
import {
  sameOrigins,
  serverIdentity,
  publicIdentityCache,
  serverIdentityResponse,
} from "@executor-js/utils/server-identity";
import { HttpApiBuilder } from "effect/http-api";
import { appUiBaseUrl } from "../contracts/config.ts";
import { catalogFeedSetting } from "@executor-js/catalog/contracts";
import { type HostEgress } from "@executor-js/utils/url-policy";
import { Config, Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { withHostPipeline } from "@executor-js/dashboard-start/in-process";
import { selfHostApi } from "./api.ts";
import { selfHostMcp } from "../mcp.ts";
import { SelfHostAuth } from "../auth.ts";
import { selfHostAnalytics } from "./product-analytics.ts";

import type { SourceTextFile as SourceFile } from "@executor-js/sdk/core";
import { SelfHostRegistry, type selfHostExecutorServices } from "./executor-services.ts";
import {
  selfHostUpdateCheck,
  selfHostUpdateStatus,
  type UpdateCheckStore,
} from "./update-check.ts";
export const selfHostRouteMap = <DashboardE, DashboardR>(options: {
  readonly skills: readonly SourceFile[];
  readonly egress: HostEgress;
  readonly executorServices: Layer.Layer<
    Layer.Success<ReturnType<typeof selfHostExecutorServices>>
  >;
  readonly dashboard: Effect.Effect<HttpServerResponse.HttpServerResponse, DashboardE, DashboardR>;
  readonly updateCheckStore: UpdateCheckStore;
}) =>
  Effect.gen(function* () {
    const { skills, egress, executorServices, dashboard } = options;
    const update = yield* selfHostUpdateCheck(
      yield* SelfHostRegistry.pipe(Effect.provide(executorServices)),
      options.updateCheckStore,
    );
    const auth = yield* SelfHostAuth.pipe(Effect.provide(executorServices));
    const serverId = yield* serverIdentity(
      "self-host",
      yield* Config.NonEmptyString("EXECUTOR_INSTALL_ID"),
    );
    const analytics = yield* selfHostAnalytics;
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
      return yield* analytics === undefined
        ? worker
        : worker.pipe(Effect.provideService(ScheduleObservation, analytics.schedules));
    }).pipe(Effect.provide(executorServices));
    const wake = scheduler.wakeWebhookSources.pipe(
      Effect.withSpan("schedule.wake", { attributes: { "executor.schedule.wake": "change" } }),
    );
    yield* drainProvisioning(selfHostProvisioningServices).pipe(
      Effect.catch(() => Effect.logWarning("Provisioning queue processing failed")),
      Effect.repeat(Schedule.spaced("1 second")),
      Effect.provideService(ScheduleWakeup, wake),
      Effect.provide(executorServices),
      Effect.forkScoped,
    );
    const clientMetadata = yield* clientMetadataSetting({
      origin: auth.origin,
      oauthRedirectUri: Option.getOrUndefined((yield* authSettings).oauthRedirectUri),
    });
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
        catalogLive(
          document.document,
          egress,
          clientMetadata,
          auth.origin,
          yield* catalogFeedSetting,
        ),
      ),
      Layer.provide(hostedMiddlewareLive),
      Layer.provide(executorServices),
      HttpRouter.provideRequest(executorServices),
      Layer.provide(auth.identity),
      Layer.provide(auth.apiIdentity),
      Layer.provide(auth.mcpIdentity),
    );
    const mcpRoutes = Layer.mergeAll(
      HttpRouter.add("*", "/mcp", mcp.http),
      HttpRouter.add("*", "/org/:organization/mcp", mcp.http),
      HttpRouter.add("GET", mcpWhoamiPath, mcpWhoami),
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
      HttpRouter.add(
        "GET",
        executorServerIdentityPath,
        serverIdentityResponse(serverId, sameOrigins(auth.origin), publicIdentityCache),
      ),
      HttpRouter.add("GET", "/api/self-host/update", selfHostUpdateStatus(update)).pipe(
        HttpRouter.provideRequest(auth.identity),
      ),
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
        HttpRouter.add(
          "GET",
          "/.well-known/oauth-protected-resource/api/desktop",
          desktopProtectedResource,
        ),
      ).pipe(HttpRouter.provideRequest(auth.apiIdentity)),
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
      HttpRouter.add("GET", appLaunchPath, appUi.launch),
      HttpRouter.add("GET", "/_executor/assets/:version/*", appUi.asset),
      HttpRouter.add("GET", "/_executor/version", appUi.versions),
      HttpRouter.add("GET", appMenuBarRoute, appUi.menuBar),
      HttpRouter.add("GET", appIconRoute, appUi.icon),
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
