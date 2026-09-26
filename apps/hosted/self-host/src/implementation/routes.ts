import { publishedSkillRoutes } from "@executor-js/app-templates/executor";
import {
  drainProvisioning,
  selfHostProvisioningServices,
} from "@executor-js/hosted-server/provisioning";
import { Schedule } from "effect";
import { executorSelfHostApiDocument } from "../contracts/api.ts";
import { startScheduleWorker, defaultScheduleWorkerOptions } from "@executor-js/sdk/scheduling";
import { gitRoutes } from "@executor-js/app-management";
import { hostedAppGitAccess } from "@executor-js/hosted-server/app-management";
/** The route map is shared by native development and the packaged Worker. */
import {
  browserTelemetry,
  requestServices,
  HostedExecutor,
  ScheduledAuthority,
  ScheduleWakeup,
  hostedOAuthCallback,
  hostedWebhookCallback,
  catalogLive,
  requireUserLive,
  requireOrganizationLive,
  mcpProtectedResource,
  mcpAuthorizationServer,
  apiChallenge,
  apiProtectedResource,
  lazyHostedApiDocument,
} from "@executor-js/hosted-server";
import { recordRequestRejections, requestTiming } from "@executor-js/telemetry/http";
import { appAddresses, hostedAppUi } from "@executor-js/hosted-server/app-ui";
import { AppSignInApi, appSignInPage, appSignInScript } from "apps/ui/auth";
import { AppUiApi } from "apps/ui/contracts";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { appUiBaseUrl } from "../contracts/config.ts";
import { type HostEgress } from "@executor-js/utils/url-policy";
import { Config, Effect, Layer, Option } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { selfHostApi } from "./api.ts";
import { selfHostMcp } from "../mcp.ts";
import { selfHostAuth } from "../auth.ts";

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
    const auth = yield* selfHostAuth;
    yield* drainProvisioning(selfHostProvisioningServices).pipe(
      Effect.catch(() => Effect.logWarning("Provisioning queue processing failed")),
      Effect.repeat(Schedule.spaced("1 second")),
      Effect.provide(executorServices),
      Effect.forkScoped,
    );
    const scheduler = yield* Effect.gen(function* () {
      const executor = yield* Effect.flatten(HostedExecutor);
      const authorize = yield* ScheduledAuthority;
      return yield* startScheduleWorker(executor, authorize, {
        ...defaultScheduleWorkerOptions,
        runner: "self-host",
        concurrency: yield* Config.Number("EXECUTOR_SCHEDULE_CONCURRENCY").pipe(
          Config.withDefault(defaultScheduleWorkerOptions.concurrency),
        ),
      });
    }).pipe(Effect.provide(executorServices));
    const addresses = appAddresses(auth.origin, yield* appUiBaseUrl(auth.origin));
    const appUi = hostedAppUi(addresses);
    const mcp = yield* selfHostMcp.pipe(Effect.provide(HttpServer.layerServices));
    const document = lazyHostedApiDocument(() => executorSelfHostApiDocument(auth.origin));
    const api = selfHostApi(document).pipe(
      Layer.provide(appUi.dashboard),
      HttpRouter.provideRequest(auth.appSessions),
      HttpRouter.provideRequest(catalogLive(skills, document.document, egress)),
      Layer.provide(requireUserLive),
      Layer.provide(requireOrganizationLive),
      HttpRouter.provideRequest(executorServices),
      Layer.provide(auth.identity),
      Layer.provide(auth.apiIdentity),
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
      publishedSkillRoutes(skills),
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
      HttpRouter.add("GET", "*", dashboard),
    );
    const notFound = HttpServerResponse.empty({ status: 404 });
    const appServices = requestServices(Layer.mergeAll(auth.appSessions, executorServices));
    const appRoutes = Layer.mergeAll(
      HttpApiBuilder.layer(AppSignInApi).pipe(Layer.provide(appUi.appAuth)),
      HttpApiBuilder.layer(AppUiApi).pipe(
        Layer.provide(appUi.calls),
        Layer.provide(appUi.sessionAccess.combine(appServices).layer),
      ),
      HttpRouter.add("GET", "/_executor/auth/callback", appSignInPage()),
      HttpRouter.add("GET", "/_executor/auth/browser.js", appSignInScript()),
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
      Effect.map((handler) =>
        handler.pipe(Effect.provideService(ScheduleWakeup, scheduler.wakeProfiles)),
      ),
    );
    const routes = HttpRouter.add(
      "*",
      "*",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (Option.isSome(addresses.fromHost(request.headers.host)))
          return yield* apps.pipe(requestTiming);
        if (addresses.ownsHost(request.headers.host)) return notFound;
        return yield* product;
      }).pipe(recordRequestRejections),
    );
    return routes;
  });
