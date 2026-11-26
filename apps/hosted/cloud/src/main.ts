import { cloudArtifactsTokensLive } from "./infrastructure/artifacts-tokens.ts";
import {
  Provisioning,
  dispatchProvisioning,
  provisionTeamNow,
} from "./infrastructure/provisioning.ts";
import { previewActivity } from "./infrastructure/preview-activity.ts";
import { previewLifetime } from "./infrastructure/test-stage-expiry.ts";
import { ExecutorCloudApi, executorCloudApiDocument } from "./contracts/api.ts";
import { hostedAppUi, appAddresses } from "@executor-js/hosted-server/app-ui";
import { cloudAppUiBase } from "./contracts/app-ui.ts";
import { cloudAppDomains } from "./infrastructure/app-domains.ts";
import { AppRepositoryRecovery, WorkflowHost } from "@executor-js/sdk/core";
import { AppWorkflows } from "./infrastructure/workflows.ts";
import { cloudDataSteps } from "./infrastructure/data-steps.ts";
import { expireIdleAgentGrants } from "@executor-js/app-management/data-steps";
import { GroupDatabase } from "@executor-js/hosted-server/groups";
import { SqlClient } from "effect/sql";
import {
  OrganizationRemoval,
  OrganizationRemovalStart,
  dispatchOrganizationRemovals,
  startOrganizationRemoval,
} from "./infrastructure/organization-removal-workflow.ts";
import {
  cloudOrganizationRemovalRecovery,
  OrganizationRemovalRecoveryLive,
} from "./infrastructure/organization-removal-recovery.ts";
import {
  localRemovalStalls,
  removalStallBindings,
} from "./infrastructure/organization-removal-stalls.ts";
import {
  HostedExecutor,
  lazyHostedApiDocument,
  pruneToolCallLog,
} from "@executor-js/hosted-server";
import { BillingMeter } from "./contracts/billing-meter.ts";
import { billingBindings } from "./infrastructure/billing.ts";
import { frameworkDocumentation, registryRoutes, gitRoutes } from "@executor-js/app-management";
import { hostedAppGitAccess } from "@executor-js/hosted-server/app-management";
import { publishedSkillRoutes } from "@executor-js/app-templates/executor";
import { hideRemovedOrganizations } from "./implementation/organization-removal.ts";
import {
  browserTelemetry,
  clientMetadataDocument,
  clientMetadataDocumentPath,
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
} from "@executor-js/hosted-server";
import * as Cloudflare from "alchemy/Cloudflare";
import { cloudSite } from "./infrastructure/site.ts";
import { cloudSiteAssets } from "./infrastructure/site-assets.ts";
import { retainedAssetFolders, retainedAssetPath } from "./contracts/retained-assets.ts";
import * as Output from "alchemy/Output";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { Config, Effect, Layer, Option, Path, Ref } from "effect";
import { Digest } from "effect/crypto";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { cloudAuth } from "./infrastructure/auth.ts";
import { cloudAccountCallback } from "./implementation/account-callback.ts";
import { v1HandoffPath } from "./implementation/v1-session-handoff.ts";
import { legacyMcp, legacyProtectedResource } from "./implementation/v1-legacy-mcp.ts";
import { invocationSql } from "./infrastructure/invocation-database.ts";
import { cloudOnboarding } from "./infrastructure/onboarding.ts";
import { cloudMcp } from "./infrastructure/mcp.ts";
import { cloudApi } from "./implementation/api.ts";
import { cachedFeedClient } from "./implementation/catalog-feed-cache.ts";
import { billingLive } from "./implementation/billing.ts";
import {
  cloudSchedules,
  PlacedScheduleCoordinatorLive,
  ScheduleCoordinatorLive,
} from "./infrastructure/schedules.ts";
import {
  cloudBackgroundJobs,
  selfBinding,
  type BackgroundJob,
} from "./infrastructure/background-jobs.ts";
import { handledJob, jobCompleted, jobFailed } from "./contracts/job-outcome.ts";
import { cloudEgress } from "./infrastructure/executor.ts";
import { servedRequest } from "./infrastructure/served-request.ts";
import { cloudProduct } from "./infrastructure/product.ts";
import { cloudAuthDatabase } from "./infrastructure/auth-database.ts";
import { EventCleanup, sqlCancellation } from "./infrastructure/event-cleanup.ts";
import {
  cloudObservability,
  cloudTelemetry,
  telemetryBindings,
} from "./infrastructure/telemetry.ts";
import { cloudEmail } from "./infrastructure/email.ts";
import { cloudWelcomeEmails } from "./infrastructure/welcome-email.ts";
import { cloudEntryApi, cloudEntryDocument, resolveCloudEntry } from "./implementation/entry.ts";
import { browserReturnTo } from "@executor-js/hosted-server/browser/contracts";
import { HttpServerRequest } from "effect/http";
import { homepage, staticDocument } from "./implementation/homepage.ts";
import { securityTxt, sitePageRoutes } from "./contracts/site-paths.ts";
import {
  accountCallback,
  apiGoneOnEdge,
  edgeFallback,
  v1ClientIdMetadata,
  v1SignIn,
  v1SignUp,
} from "./implementation/v1-edge.ts";
import { v1AuthKitHost } from "./implementation/v1-authkit.ts";
import { withNotFoundDocument, notFoundDocument } from "./implementation/not-found.ts";
import { openAiAppsChallenge } from "./implementation/openai-apps-challenge.ts";
import {
  cloudDashboard,
  dashboardPageRoutes,
  organizationRoot,
} from "./implementation/dashboard.ts";
import { withHostPipeline } from "@executor-js/dashboard-start/in-process";
import { dashboardBatchPath } from "@executor-js/dashboard-start/batch";
import { workerFirstRoutes } from "./contracts/worker-first-routes.ts";
import { postHogBindings } from "./infrastructure/posthog.ts";
import { cloudAnalytics } from "./implementation/product-analytics.ts";
import { workerBuild } from "./infrastructure/worker-build.ts";
import { reportCloudFailure } from "./implementation/error-reporting.ts";
import { sentryBindings } from "./infrastructure/sentry.ts";
import { cloudErrorTunnel } from "./implementation/error-tunnel.ts";
import { cloudSentry } from "./implementation/error-reporting.ts";
import {
  authRateLimitSwitchBindings,
  cloudOrigin,
  customDomain,
  productionApiWorkerName,
  productionStage,
  removalRevocationBudgetBindings,
  stageName,
} from "./infrastructure/stage.ts";
import { roleHostRoutes } from "./infrastructure/role-hosts.ts";
import { redirectTo, withRoleHosts } from "./implementation/host-roles.ts";
import { hasSessionCookie } from "./contracts/browser.ts";
import {
  clientMetadataBinding,
  cloudClientMetadata,
  deploymentClientMetadata,
} from "./infrastructure/client-metadata.ts";
import { appDataSupervisors } from "./infrastructure/app-data.ts";
import { cloudDevelopment } from "./contracts/development.ts";
import { recordUnclassifiedRefusals, requestServices } from "@executor-js/hosted-server";
import {
  toRequestHttpEffect,
  recordRequestRejections,
  requestTiming,
} from "@executor-js/telemetry/http";
import { recordClientNetwork } from "./implementation/client-network.ts";
import { executorServerIdentityPath } from "apps/ui/contracts";
import {
  publicIdentityCache,
  serverIdentity,
  serverIdentityResponse,
} from "@executor-js/utils/server-identity";

import { appCatalogBinding } from "./infrastructure/app-catalog.ts";
import { Api } from "./infrastructure/api-worker.ts";
import { Dashboard } from "./infrastructure/dashboard-worker.ts";
import { cloudSourceFormatter } from "./infrastructure/source-formatter.ts";
import { cloudAuthoringReference } from "./infrastructure/authoring-reference.ts";
import { productBrandBindings } from "./infrastructure/product-brand.ts";
import { CurrentProductBrand, productBrandConfig } from "@executor-js/utils/product-brand";
export { Api } from "./infrastructure/api-worker.ts";

export default Api.make(
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };
    const { dev } = yield* AlchemyContext;
    const path = yield* Path.Path;
    const origin = dev ? undefined : new URL(yield* cloudOrigin.pipe(Effect.orDie));
    const placement = dev
      ? undefined
      : { region: yield* Config.NonEmptyString("CLOUD_PLACEMENT_REGION") };
    const analytics = yield* postHogBindings;
    const sentry = yield* sentryBindings;
    const site = yield* cloudSite;
    const pinnedName =
      Option.getOrUndefined(yield* stageName) === productionStage
        ? { name: productionApiWorkerName }
        : {};
    return {
      main: import.meta.url,
      ...pinnedName,
      ...(yield* cloudObservability),
      env: {
        ...(yield* telemetryBindings),
        ...analytics.env,
        CLOUDFLARE_ACCOUNT_ID: yield* Config.String("CLOUDFLARE_ACCOUNT_ID"),
        [selfBinding]: Cloudflare.Workers.Self,
        ...sentry.env,
        ...(yield* billingBindings),
        ...(yield* removalStallBindings),
        ...(yield* authRateLimitSwitchBindings),
        ...(yield* removalRevocationBudgetBindings),
        ...(origin === undefined ? {} : yield* clientMetadataBinding.pipe(Effect.orDie)),
        ...(origin === undefined ? {} : yield* appCatalogBinding),
        ...(yield* productBrandBindings),
      },
      build: workerBuild("api"),
      ...(origin === undefined ? {} : { domain: yield* customDomain(origin) }),
      ...(dev ? {} : yield* roleHostRoutes),
      ...(placement === undefined ? {} : { placement }),
      limits: { subrequests: 50_000 },
      compatibility: {
        date: "2026-09-08",
        flags: [
          "nodejs_compat",
          "global_fetch_strictly_public",
          "enable_request_signal",
          "no_brotli_content_encoding",
        ],
      },
      dev: {
        host: "127.0.0.1",
        port: dev ? (yield* cloudDevelopment.pipe(Effect.orDie)).apiPort : 4411,
        strictPort: true,
      },
      assets: {
        directory: dev
          ? site.outdir.pipe(Output.map((directory) => path.resolve(directory)))
          : site.outdir,
        hash: site.hash.output,
        notFoundHandling: "none",
        htmlHandling: "none",
        runWorkerFirst: workerFirstRoutes,
      },
    };
  }),
  Effect.gen(function* () {
    const brand = yield* CurrentProductBrand;
    const lifetime = yield* previewLifetime;
    const activity = yield* previewActivity;
    const analytics = yield* cloudAnalytics;
    const reportErrors = yield* cloudSentry;
    const errorTunnel = yield* cloudErrorTunnel;
    const email = yield* cloudEmail.pipe(Effect.orDie);
    const onboarding = yield* cloudOnboarding.pipe(Effect.orDie);
    const auth = yield* cloudAuth(email.send);
    const welcomeEmails = yield* cloudWelcomeEmails(email.welcome);
    yield* AppWorkflows;
    yield* Provisioning;
    const executor = yield* cloudProduct(
      yield* appDataSupervisors,
      yield* cloudArtifactsTokensLive,
    );
    const billing = yield* billingLive.pipe(Effect.orDie);
    const removal = yield* OrganizationRemoval.pipe(
      Effect.provide(Layer.mergeAll(executor, auth.identity, billing)),
    );
    const removals = Layer.merge(
      Layer.succeed(
        OrganizationRemovalStart,
        startOrganizationRemoval(yield* localRemovalStalls(removal, executor)),
      ),
      yield* cloudOrganizationRemovalRecovery,
    );
    const schedules = yield* cloudSchedules;
    const installTeam = (job: string) =>
      provisionTeamNow(job).pipe(
        Effect.provide(schedules.immediateLayer),
        Effect.timeoutOption("15 seconds"),
        Effect.withSpan("job.provisioning.install"),
        Effect.catch(() => Effect.logWarning("Team installation left to its workflow", { job })),
        Effect.asVoid,
      );
    const dispatchWith = <R>(install: (job: string) => Effect.Effect<void, never, R>) =>
      dispatchProvisioning(install).pipe(
        Effect.provide(executor),
        Effect.scoped,
        Effect.withSpan("job.provisioning.dispatch"),
        Effect.catch((error) =>
          Effect.logWarning("Provisioning outbox unavailable").pipe(Effect.as(jobFailed(error))),
        ),
      );
    const dispatch = dispatchWith(() => Effect.void);
    const organizationRemovals = dispatchOrganizationRemovals.pipe(
      Effect.provide(Layer.merge(executor, removals)),
      Effect.scoped,
      Effect.as(jobCompleted),
    );
    const startJobs = dispatchWith(installTeam).pipe(lifetime.background);
    const cleanup = yield* EventCleanup;
    const dispatchAfterWrites = <E, R>(
      handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
    ) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return yield* handler;
        const execution = yield* Cloudflare.WorkerExecutionContext;
        const jobs = (yield* cleanup.deadline)
          .within(startJobs, { reserve: sqlCancellation })
          .pipe(Effect.asVoid);
        const streamed = yield* Ref.make(false);
        yield* Effect.addFinalizer(() =>
          Ref.get(streamed).pipe(
            Effect.flatMap((detach) => (detach ? execution.waitUntil(jobs) : jobs)),
          ),
        );
        return yield* handler.pipe(
          Effect.tap((response) => Ref.set(streamed, response.body._tag === "Stream")),
        );
      });
    const dataSteps = (yield* cloudDataSteps(auth.agentGrants)).pipe(
      Effect.provide(schedules.layer),
      Effect.provide(executor),
      reportErrors,
      Effect.scoped,
      handledJob(Effect.logWarning("Data steps unavailable")),
    );
    const repositoryRecovery = Effect.flatten(AppRepositoryRecovery).pipe(
      Effect.provide(executor),
      reportErrors,
      Effect.scoped,
      Effect.withSpan("job.repository.recover"),
      Effect.as(jobCompleted),
      handledJob(Effect.logWarning("App repository recovery failed")),
    );
    const appDomains = yield* cloudAppDomains;
    const siteAssets = yield* cloudSiteAssets;
    const siteAssetRetention = siteAssets.retainCurrent.pipe(
      reportErrors,
      Effect.scoped,
      Effect.as(jobCompleted),
      handledJob(Effect.logWarning("Site asset retention failed")),
    );
    const dashboard = cloudDashboard(yield* Cloudflare.Workers.bindWorker(Dashboard), {
      resourceOrigins: auth.resourceOrigins,
      formerPasskeyHost: Option.isSome(auth.hosts.roles)
        ? new URL(auth.hosts.deployment).hostname
        : null,
      documentation: new URL("/docs/", auth.hosts.site).href,
    });
    const appUi = hostedAppUi(
      appAddresses(auth.origin, yield* cloudAppUiBase.pipe(Effect.orDie)),
      appDomains.status,
    );
    const mcp = yield* cloudMcp;
    const meter = yield* BillingMeter.pipe(Effect.provide(billing));
    const workflowReconcile = Effect.flatten(HostedExecutor).pipe(
      Effect.flatMap((sdk) => sdk[WorkflowHost].reconcile),
      Effect.provide(executor),
      reportErrors,
      Effect.scoped,
      Effect.withSpan("job.workflow.reconcile"),
      Effect.as(jobCompleted),
      handledJob(Effect.logWarning("Workflow queue reconciliation failed")),
    );
    const billingReconcile = meter.reconcileSeats.pipe(
      reportErrors,
      Effect.scoped,
      Effect.withSpan("job.billing.reconcile"),
      Effect.as(jobCompleted),
      handledJob(Effect.logError("Billing seat reconciliation failed")),
    );
    const agentGrantExpiry = Effect.gen(function* () {
      const sql = yield* Effect.flatten(GroupDatabase);
      yield* expireIdleAgentGrants(auth.agentGrants, "private_hosted").pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
    }).pipe(
      Effect.provide(executor),
      reportErrors,
      Effect.scoped,
      Effect.as(jobCompleted),
      handledJob(Effect.logWarning("Idle agent grant expiry failed")),
    );
    const toolCallLog = Effect.gen(function* () {
      const sql = yield* Effect.flatten(GroupDatabase);
      yield* pruneToolCallLog.pipe(Effect.provideService(SqlClient.SqlClient, sql));
    }).pipe(
      Effect.provide(executor),
      reportErrors,
      Effect.scoped,
      Effect.as(jobCompleted),
      handledJob(Effect.logWarning("Tool call log pruning failed")),
    );
    const jobs = yield* cloudBackgroundJobs;
    yield* jobs.schedule(
      "* * * * *",
      "organization-removal",
      "provisioning",
      "data-steps",
      "repository-recovery",
      "schedule-wake",
      "site-assets",
    );
    yield* jobs.schedule(
      "*/5 * * * *",
      "welcome-emails",
      "workflow-reconcile",
      "app-domain-heartbeat",
      "tool-call-log",
    );
    yield* jobs.schedule("17 4 * * *", "billing-reconcile", "agent-grant-expiry");
    const backgroundJobs = {
      "organization-removal": organizationRemovals,
      provisioning: dispatch,
      "data-steps": dataSteps,
      "repository-recovery": repositoryRecovery,
      "schedule-wake": schedules.wake.pipe(Effect.as(jobCompleted)),
      "site-assets": siteAssetRetention,
      "app-domain-heartbeat": appDomains.heartbeat,
      "welcome-emails": welcomeEmails.deliver,
      "workflow-reconcile": workflowReconcile,
      "billing-reconcile": billingReconcile,
      "agent-grant-expiry": agentGrantExpiry,
      "tool-call-log": toolCallLog,
    } satisfies Record<BackgroundJob, unknown>;

    const egress = yield* cloudEgress;
    const clientMetadata = yield* cloudClientMetadata.pipe(Effect.orDie);
    const deploymentDocument = yield* deploymentClientMetadata(clientMetadata).pipe(Effect.orDie);
    const catalogFeedUrl = Option.getOrUndefined(
      yield* Config.String("EXECUTOR_CATALOG_URL").pipe(Config.option),
    );
    const apiOrigin = auth.resourceOrigins.api[0];
    const serverId = yield* serverIdentity("cloud", auth.origin);
    const document = lazyHostedApiDocument(() => executorCloudApiDocument(apiOrigin));
    const authoring = yield* cloudAuthoringReference;
    const api = cloudApi(document).pipe(
      Layer.provide(frameworkDocumentation(authoring)),
      HttpRouter.provideRequest(yield* cloudSourceFormatter),
      Layer.provide(appUi.dashboard),
      Layer.provide(requestServices(auth.appSessions).layer),
      HttpRouter.provideRequest(
        catalogLive(
          document.document,
          catalogFeedUrl === undefined
            ? egress
            : {
                ...egress,
                client: yield* cachedFeedClient(apiOrigin, catalogFeedUrl, egress.client),
              },
          clientMetadata,
          apiOrigin,
          catalogFeedUrl,
        ),
      ),
      Layer.provide(schedules.layer),
      Layer.provide(billing),
      Layer.provide(removals),
      Layer.provide(onboarding),
      Layer.provide(hostedMiddlewareLive),
      Layer.provide(executor),
      HttpRouter.provideRequest(executor),
      Layer.provide(auth.identity),
      Layer.provide(auth.apiIdentity),
      Layer.provide(auth.mcpIdentity),
    );
    const memoMap = yield* Layer.makeMemoMap;
    const buildApi = api.pipe(
      Layer.provide(HttpServer.layerServices),
      toRequestHttpEffect,
      Effect.provideService(Layer.CurrentMemoMap, memoMap),
    );
    const apiServices = yield* Effect.context<Effect.Services<typeof buildApi>>();
    let apiHandle: Effect.Success<typeof buildApi> | undefined;
    const apiRequest = Effect.suspend(
      () => (apiHandle ??= Effect.runSync(Effect.provideContext(buildApi, apiServices))),
    );
    const apiRoutes = HttpRouter.addAll([
      HttpRouter.route("GET", "/openapi.json", apiRequest),
      HttpRouter.route("POST", dashboardBatchPath, apiRequest),
      ...Object.values(ExecutorCloudApi.groups).flatMap((group) =>
        Object.values(group.endpoints).map((endpoint) =>
          HttpRouter.route(endpoint.method, endpoint.path, dispatchAfterWrites(apiRequest)),
        ),
      ),
    ]);
    // RFC 8414 metadata, at the issuer's path and at the root for clients that look there.
    const authorizationServerRoutes = Layer.mergeAll(
      HttpRouter.add("GET", "/.well-known/oauth-authorization-server", mcpAuthorizationServer),
      HttpRouter.add(
        "GET",
        "/.well-known/oauth-authorization-server/api/auth",
        mcpAuthorizationServer,
      ),
    ).pipe(HttpRouter.provideRequest(auth.mcpIdentity));
    const mcpRoutes = Layer.mergeAll(
      HttpRouter.add("*", "/mcp", mcp.http),
      HttpRouter.add("*", "/org/:organization/mcp", mcp.http),
      HttpRouter.add("GET", mcpWhoamiPath, mcpWhoami),
      HttpRouter.add("GET", "/.well-known/oauth-protected-resource", mcpProtectedResource),
      HttpRouter.add("GET", "/.well-known/oauth-protected-resource/mcp", mcpProtectedResource),
    ).pipe(HttpRouter.provideRequest(auth.mcpIdentity));
    const withSql = yield* invocationSql;
    const legacy = legacyMcp(withSql, mcp.http);
    const legacyDiscovery = legacyProtectedResource(withSql);
    const legacyMcpRoutes = Layer.mergeAll(
      HttpRouter.add("*", "/mcp", legacy),
      HttpRouter.add("GET", mcpWhoamiPath, mcpWhoami),
      HttpRouter.add("*", "/mcp/toolkits/:toolkit", legacy),
      HttpRouter.add("*", "/:selector/mcp", legacy),
      HttpRouter.add("*", "/:selector/mcp/toolkits/:toolkit", legacy),
      HttpRouter.add("GET", "/.well-known/oauth-protected-resource/mcp", legacyDiscovery),
      HttpRouter.add(
        "GET",
        "/.well-known/oauth-protected-resource/mcp/toolkits/:toolkit",
        legacyDiscovery,
      ),
      HttpRouter.add("GET", "/.well-known/oauth-protected-resource/:selector/mcp", legacyDiscovery),
      HttpRouter.add(
        "GET",
        "/.well-known/oauth-protected-resource/:selector/mcp/toolkits/:toolkit",
        legacyDiscovery,
      ),
    ).pipe(HttpRouter.provideRequest(auth.mcpIdentity));
    const apiDiscoveryRoutes = Layer.mergeAll(
      HttpRouter.add("GET", "/api", apiChallenge),
      HttpRouter.add("GET", "/.well-known/oauth-protected-resource/api", apiProtectedResource),
      HttpRouter.add(
        "GET",
        "/.well-known/oauth-protected-resource/api/desktop",
        desktopProtectedResource,
      ),
    ).pipe(HttpRouter.provideRequest(auth.apiIdentity));
    const appWebhookRoutes = HttpRouter.add(
      "*",
      "/api/webhooks/:appId/:subscriptionId",
      hostedWebhookCallback,
    ).pipe(HttpRouter.provideRequest(executor), HttpRouter.provideRequest(schedules.layer));
    const withGitAccess = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
      layer.pipe(
        HttpRouter.provideRequest(hostedAppGitAccess),
        HttpRouter.provideRequest(executor),
        Layer.provide(auth.identity),
        Layer.provide(auth.apiIdentity),
      );
    const authoringRoutes = withGitAccess(Layer.mergeAll(registryRoutes, gitRoutes));
    const sitePage = Effect.gen(function* () {
      const response = yield* staticDocument();
      if (response.status !== 404) return response;
      const request = yield* HttpServerRequest.HttpServerRequest;
      return retainedAssetPath.test(new URL(request.url, "http://localhost").pathname.slice(1))
        ? yield* siteAssets.serve
        : yield* notFoundDocument;
    });
    const siteRoutes = HttpRouter.addAll(
      sitePageRoutes.map((page) => HttpRouter.route("GET", page, sitePage)),
    );
    const securityTxtRoute = HttpRouter.add("GET", securityTxt, staticDocument());
    const siteTelemetryRoutes = Layer.mergeAll(
      HttpRouter.add("*", "/api/:channel/*", analytics.proxy),
      HttpRouter.add("POST", "/api/:channel/submit", errorTunnel),
    );
    const routes = Layer.mergeAll(
      HttpRouter.add("POST", "/api/internal/app-domains/resume", appDomains.control("resume")),
      HttpRouter.add("POST", "/api/internal/app-domains/drain", appDomains.control("drain")),
      jobs.route((job) => backgroundJobs[job]),
      authoringRoutes,
      ...(["login", "login/sso", "create"] as const).map((page) =>
        HttpRouter.add(
          "GET",
          `/${page}`,
          cloudEntryDocument(
            Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
              resolveCloudEntry(
                auth.browserSession,
                page,
                browserReturnTo(new URL(request.url, auth.origin).searchParams.get("redirect")),
                new Headers(request.headers),
              ),
            ),
            dashboard,
          ),
        ).pipe(HttpRouter.provideRequest(onboarding)),
      ),
      HttpRouter.add("GET", "/api/entry", cloudEntryApi(auth.browserSession)).pipe(
        HttpRouter.provideRequest(onboarding),
      ),
      apiRoutes,
      ...retainedAssetFolders.map((folder) =>
        HttpRouter.add("GET", `/${folder}/*`, siteAssets.serve),
      ),
      publishedSkillRoutes(authoring),
      siteRoutes,
      securityTxtRoute,
      siteTelemetryRoutes,
      browserTelemetry.pipe(HttpRouter.provideRequest(auth.identity)),
      HttpRouter.add("GET", "/", homepage(auth.cookiePrefix, dashboard(null))),
      HttpRouter.add("GET", "/org/:organizationSlug", organizationRoot),
      ...dashboardPageRoutes.map((route) =>
        route === "/app-auth"
          ? HttpRouter.add("GET", route, appUi.signIn(dashboard(null))).pipe(
              Layer.provide(requestServices(auth.appSessions).layer),
              HttpRouter.provideRequest(executor),
              HttpRouter.provideRequest(auth.identity),
            )
          : HttpRouter.add("GET", route, dashboard(null)),
      ),
      appWebhookRoutes,
      HttpRouter.add(
        "GET",
        "/api/auth/organization/list",
        auth.handler.pipe(Effect.flatMap(hideRemovedOrganizations), Effect.provide(executor)),
      ),
      HttpRouter.add("*", "/api/auth/*", dispatchAfterWrites(auth.handler)),
      HttpRouter.add(
        "GET",
        executorServerIdentityPath,
        serverIdentityResponse(
          serverId,
          {
            dashboard: auth.hosts.browser,
            api: auth.hosts.resourceOrigins.api[0],
            auth: new URL(auth.hosts.issuer).origin,
          },
          publicIdentityCache,
        ),
      ),
      HttpRouter.add("GET", v1HandoffPath, auth.v1Handoff),
      HttpRouter.add("*", "/api/email/unsubscribe", welcomeEmails.unsubscribe),
      HttpRouter.add(
        "GET",
        "/api/oauth/callback",
        cloudAccountCallback(auth.returnsStageAccountCallback),
      ).pipe(HttpRouter.provideRequest(auth.identity)),
      HttpRouter.add(
        "GET",
        clientMetadataDocumentPath,
        clientMetadataDocument(deploymentDocument),
      ).pipe(HttpRouter.provideRequest(auth.identity)),
      mcpRoutes,
      authorizationServerRoutes,
      HttpRouter.add("GET", "/.well-known/openai-apps-challenge", openAiAppsChallenge),
      Layer.mergeAll(
        HttpRouter.add("GET", "/api/mcp/approvals/:requestId", mcp.approvals),
        HttpRouter.add("POST", "/api/mcp/approvals/:requestId", mcp.approvals),
      ).pipe(HttpRouter.provideRequest(auth.mcpIdentity)),
      apiDiscoveryRoutes,
    );
    const handle = yield* routes.pipe(
      Layer.provide(HttpServer.layerServices),
      toRequestHttpEffect,
      Effect.provideService(Layer.CurrentMemoMap, memoMap),
    );
    const mcpHost = yield* Layer.mergeAll(
      mcpRoutes,
      authorizationServerRoutes,
      HttpRouter.add("GET", "/.well-known/openai-apps-challenge", openAiAppsChallenge),
      securityTxtRoute,
    ).pipe(
      Layer.provide(HttpServer.layerServices),
      toRequestHttpEffect,
      Effect.provideService(Layer.CurrentMemoMap, memoMap),
    );
    const apiHost = yield* Layer.mergeAll(
      apiRoutes,
      apiDiscoveryRoutes,
      HttpRouter.add("GET", "/.well-known/oauth-protected-resource/mcp", mcpProtectedResource).pipe(
        HttpRouter.provideRequest(auth.mcpIdentity),
      ),
      authorizationServerRoutes,
      appWebhookRoutes,
      publishedSkillRoutes(authoring),
      withGitAccess(registryRoutes),
    ).pipe(
      Layer.provide(HttpServer.layerServices),
      toRequestHttpEffect,
      Effect.provideService(Layer.CurrentMemoMap, memoMap),
    );
    const edgeHost = yield* Layer.mergeAll(
      authorizationServerRoutes,
      legacyMcpRoutes,
      HttpRouter.add("GET", "/api/auth/callback/:provider", redirectTo(auth.origin, 302)),
      HttpRouter.add(
        "GET",
        "/api/oauth/callback",
        accountCallback(auth.origin, cloudAccountCallback(auth.returnsStageAccountCallback)),
      ).pipe(HttpRouter.provideRequest(auth.identity)),
      HttpRouter.add("GET", clientMetadataDocumentPath, clientMetadataDocument(clientMetadata)),
      withGitAccess(gitRoutes),
      HttpRouter.add("GET", "/", staticDocument("/index.html")),
      siteRoutes,
      siteTelemetryRoutes,
      publishedSkillRoutes(authoring),
      HttpRouter.addAll([
        HttpRouter.route("GET", "/api/oauth/client-id-metadata.json", v1ClientIdMetadata),
        HttpRouter.route("GET", "/api/oauth/client-id-metadata/*", v1ClientIdMetadata),
        HttpRouter.route("GET", "/login", v1SignIn(auth.origin)),
        ...(["login", "callback", "logout", "me"] as const).map((path) =>
          HttpRouter.route("*", `/api/auth/${path}`, v1SignIn(auth.origin)),
        ),
        HttpRouter.route("GET", "/sign-up", v1SignUp(auth.origin)),
        HttpRouter.route("GET", "/signup", v1SignUp(auth.origin)),
        HttpRouter.route("GET", "/org/*", redirectTo(auth.origin, 308)),
        HttpRouter.route(
          "*",
          "/*",
          edgeFallback({
            withSql,
            browser: auth.origin,
            api: `${auth.resourceOrigins.api[0]}/api`,
            notFound: notFoundDocument,
          }),
        ),
      ]),
    ).pipe(
      Layer.provide(HttpServer.layerServices),
      toRequestHttpEffect,
      Effect.provideService(Layer.CurrentMemoMap, memoMap),
    );
    const roleHosts = withRoleHosts(
      auth.hosts,
      (headers) => hasSessionCookie(new Headers(headers), auth.cookiePrefix),
      {
        mcp: mcpHost,
        api: apiHost,
        edge: edgeHost.pipe(apiGoneOnEdge(`${auth.resourceOrigins.api[0]}/api`)),
        authKit: v1AuthKitHost(auth.origin),
      },
    );
    return {
      fetch: handle.pipe(
        roleHosts,
        withNotFoundDocument,
        Effect.tapCause(reportCloudFailure),
        Effect.catchTag("AuthenticationUnavailable", () =>
          Effect.succeed(HttpServerResponse.empty({ status: 503 })),
        ),
        // Unsubscribe links are bearer capabilities. `TracerDisabledWhen` cannot keep
        // them off a span here: the adapter reads the reference in an outer fiber,
        // above anything this handler provides, so it always resolved to its default.
        // The telemetry tracer allowlists HTTP span attributes instead, so neither the
        // query string nor the redirect `Location` is ever recorded, on this route,
        // on the RFC 8058 POST, or on any outbound provider request.
        analytics.wrap,
        recordRequestRejections,
        reportErrors,
        requestTiming,
        recordClientNetwork,
        recordUnclassifiedRefusals,
        withHostPipeline,
        activity.http(
          (request) =>
            request.headers.authorization !== undefined ||
            hasSessionCookie(new Headers(request.headers), auth.cookiePrefix),
        ),
        lifetime.http,
        servedRequest,
        Effect.provideService(CurrentProductBrand, brand),
      ),
    };
  }).pipe(
    Effect.provideServiceEffect(CurrentProductBrand, productBrandConfig.pipe(Effect.orDie)),
    Effect.provide(
      Layer.mergeAll(
        PlacedScheduleCoordinatorLive.pipe(Layer.provideMerge(ScheduleCoordinatorLive)),
        OrganizationRemovalRecoveryLive,
        cloudAuthDatabase,
        cloudTelemetry,
        Cloudflare.Workers.CronEventSourceLive,
        Digest.layerWebCrypto,
      ),
    ),
  ),
);
