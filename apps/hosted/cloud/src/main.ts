import { cloudArtifactsTokensLive } from "./infrastructure/artifacts-tokens.ts";
import {
  Provisioning,
  dispatchProvisioning,
  provisionTeamNow,
} from "./infrastructure/provisioning.ts";
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
import { HostedExecutor, lazyHostedApiDocument } from "@executor-js/hosted-server";
import { BillingMeter } from "./contracts/billing-meter.ts";
import { billingBindings } from "./infrastructure/billing.ts";
import { frameworkDocumentation, registryRoutes, gitRoutes } from "@executor-js/app-management";
import { hostedAppGitAccess } from "@executor-js/hosted-server/app-management";
/** Cloudflare composition edge. Alchemy owns the Effect runtime and request scopes. */
import { publishedSkillRoutes } from "@executor-js/app-templates/executor";
import { hideRemovedOrganizations } from "./implementation/organization-removal.ts";
import {
  browserTelemetry,
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
} from "@executor-js/hosted-server";
import * as Cloudflare from "alchemy/Cloudflare";
import { cloudSite } from "./infrastructure/site.ts";
import { cloudSiteAssets } from "./infrastructure/site-assets.ts";
import { retainedAssetFolders, retainedAssetPath } from "./contracts/retained-assets.ts";
import * as Output from "alchemy/Output";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { Config, Effect, Layer, Option, Path, Ref } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { cloudAuth } from "./infrastructure/auth.ts";
import { cloudOnboarding } from "./infrastructure/onboarding.ts";
import { Onboarding } from "./contracts/onboarding.ts";
import { cloudMcp } from "./infrastructure/mcp.ts";
import { cloudApi } from "./implementation/api.ts";
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
import { cloudEgress } from "./infrastructure/executor.ts";
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
import { sitePageRoutes } from "./contracts/site-paths.ts";
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
  stageName,
} from "./infrastructure/stage.ts";
import { roleHostRoutes } from "./infrastructure/role-hosts.ts";
import { redirectTo, withRoleHosts } from "./implementation/host-roles.ts";
import { hasSessionCookie } from "./contracts/browser.ts";
import { clientMetadataBinding } from "./infrastructure/client-metadata.ts";
import { appDataSupervisors } from "./infrastructure/app-data.ts";
import { cloudDevelopment } from "./contracts/development.ts";
import { requestServices } from "@executor-js/hosted-server";
import { recordRequestRejections, requestTiming } from "@executor-js/telemetry/http";

import { Api } from "./infrastructure/api-worker.ts";
import { Dashboard } from "./infrastructure/dashboard-worker.ts";
import { cloudSourceFormatter } from "./infrastructure/source-formatter.ts";
export { Api } from "./infrastructure/api-worker.ts";

export default Api.make(
  Effect.gen(function* () {
    // Native Worker props are also evaluated during runtime initialization.
    // The build-time flag also lets Rolldown remove provisioning imports.
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };
    const { dev } = yield* AlchemyContext;
    const path = yield* Path.Path;
    const origin = dev ? undefined : new URL(yield* cloudOrigin.pipe(Effect.orDie));
    // The schedule coordinator is created beside its first caller, which must be this Worker's
    // placed fetch handler, so a deployed API Worker cannot go out unplaced.
    const placement = dev
      ? undefined
      : { region: yield* Config.NonEmptyString("CLOUD_PLACEMENT_REGION") };
    const analytics = yield* postHogBindings;
    const sentry = yield* sentryBindings;
    const site = yield* cloudSite;
    // v1's edge binds to production's Worker by name.
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
        // Cron Triggers reach the placed fetch handler through this binding.
        [selfBinding]: Cloudflare.Workers.Self,
        ...sentry.env,
        ...(yield* billingBindings),
        // Local tests stall chosen removal starts; deployed Workers never install the hook.
        ...(yield* removalStallBindings),
        // Only local e2e Clouds may turn the auth rate limit off; deployed Workers get `false`.
        ...(yield* authRateLimitSwitchBindings),
        // A deployed stage identifies Executor to authorization servers by its own document.
        ...(origin === undefined ? {} : yield* clientMetadataBinding(origin)),
      },
      build: workerBuild("api"),
      // Auth callbacks and the dashboard share the configured canonical origin.
      ...(origin === undefined ? {} : { domain: yield* customDomain(origin) }),
      // The role hosts are zone routes, not custom domains: they order no certificate.
      ...(dev ? {} : yield* roleHostRoutes),
      // The database's cloud region is a proximity hint, not a Cloudflare data center or a
      // change to local development routing.
      ...(placement === undefined ? {} : { placement }),
      compatibility: {
        date: "2026-09-08",
        flags: ["nodejs_compat", "global_fetch_strictly_public", "enable_request_signal"],
      },
      dev: {
        host: "127.0.0.1",
        port: dev ? (yield* cloudDevelopment.pipe(Effect.orDie)).apiPort : 4411,
        strictPort: true,
      },
      assets: {
        // Resolve the dev asset root once before Alchemy hands it to workerd.
        directory: dev
          ? site.outdir.pipe(Output.map((directory) => path.resolve(directory)))
          : site.outdir,
        hash: site.hash.output,
        // A miss reaches the Worker: an earlier deploy's retained file, or 404.html; see
        // `site-assets.ts` and `not-found.ts`.
        notFoundHandling: "none",
        // Preserve TanStack paths after an internal index.html rewrite.
        htmlHandling: "none",
        runWorkerFirst: workerFirstRoutes,
      },
    };
  }),
  Effect.gen(function* () {
    const lifetime = yield* previewLifetime;
    const analytics = yield* cloudAnalytics;
    const reportErrors = yield* cloudSentry;
    const errorTunnel = yield* cloudErrorTunnel;
    const email = yield* cloudEmail.pipe(Effect.orDie);
    const onboarding = yield* cloudOnboarding.pipe(Effect.orDie);
    const auth = yield* cloudAuth(email.send, yield* Onboarding.pipe(Effect.provide(onboarding)));
    const welcomeEmails = yield* cloudWelcomeEmails(email.welcome);
    yield* AppWorkflows;
    yield* Provisioning;
    const executor = yield* cloudProduct(
      yield* appDataSupervisors,
      yield* cloudArtifactsTokensLive,
    );
    const billing = yield* billingLive.pipe(Effect.orDie);
    // The removal workflow runs in this isolate and shares its services.
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
    // A new team's default app is installed right after its workflow starts, in this isolate,
    // rather than after the workflow is scheduled. The workflow finishes an install cut short
    // here, so a failure is only logged.
    const installTeam = (job: string) =>
      provisionTeamNow(job).pipe(
        // The installation saves default profiles; their setup starts at once, not on a later wake.
        // It already runs after its request's response.
        Effect.provide(schedules.immediateLayer),
        Effect.timeoutOption("15 seconds"),
        Effect.withSpan("job.provisioning.install"),
        Effect.catch(() => Effect.logWarning("Team installation left to its workflow", { job })),
        Effect.asVoid,
      );
    const dispatchWith = <R>(install: (job: string) => Effect.Effect<void, never, R>) =>
      dispatchProvisioning(install).pipe(
        Effect.provide(executor),
        // A request finalizer runs after its SQL pool closes. Dispatch owns a
        // fresh scope so execution memos cannot reuse that closed pool.
        Effect.scoped,
        Effect.withSpan("job.provisioning.dispatch"),
        Effect.catch(() => Effect.logWarning("Provisioning outbox unavailable")),
      );
    // Cron only recovers lost dispatches; their workflows install any team.
    const dispatch = dispatchWith(() => Effect.void);
    // Fails while a start remains pending, so the recovery alarm that requested it tries again.
    const organizationRemovals = dispatchOrganizationRemovals.pipe(
      Effect.provide(Layer.merge(executor, removals)),
      Effect.scoped,
    );
    // Jobs are queued by triggers on users, teams and members. Only auth and dashboard API
    // writes change those rows, so only their requests start the jobs at once. MCP, telemetry
    // and the other routes skip the extra connection and query. Cron recovers any lost dispatch.
    const startJobs = dispatchWith(installTeam).pipe(lifetime.background);
    const cleanup = yield* EventCleanup;
    // The event scope closes through waitUntil after a complete response is sent, so it waits
    // for the jobs and exports their telemetry. A streamed body closes that scope at EOF instead;
    // the jobs then detach so they cannot hold EOF. Either way they end by the event's cleanup
    // deadline, after the Better Auth work the request left running, and before the export.
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
      // A step's redeploys wake profile setup once, after the job's request answers.
      Effect.provide(schedules.layer),
      Effect.provide(executor),
      reportErrors,
      Effect.scoped,
      Effect.catch(() => Effect.logWarning("Data steps unavailable")),
    );
    const repositoryRecovery = Effect.flatten(AppRepositoryRecovery).pipe(
      Effect.provide(executor),
      reportErrors,
      Effect.scoped,
      Effect.withSpan("job.repository.recover"),
      Effect.catch(() => Effect.logWarning("App repository recovery failed")),
    );
    const appDomains = yield* cloudAppDomains;
    const siteAssets = yield* cloudSiteAssets;
    // Keeps this build's browser files in R2 for pages still on it after the next deploy.
    const siteAssetRetention = siteAssets.retainCurrent.pipe(
      reportErrors,
      Effect.scoped,
      Effect.catch(() => Effect.logWarning("Site asset retention failed")),
    );
    const dashboard = cloudDashboard(yield* Cloudflare.Workers.bindWorker(Dashboard), {
      resourceOrigins: auth.resourceOrigins,
      // Passkeys made before the dashboard moved belong to the deployment's own host. They stay
      // unusable under the rollback switch: the relying party remains the role hosts' domain.
      formerPasskeyHost: Option.isSome(auth.hosts.roles)
        ? new URL(auth.hosts.deployment).hostname
        : null,
      // Documentation is a site page, served by the edge when the deployment has role hosts.
      documentation: new URL("/docs/", auth.hosts.site).href,
    });
    const appUi = hostedAppUi(
      appAddresses(auth.origin, yield* cloudAppUiBase.pipe(Effect.orDie)),
      appDomains.status,
    );
    // Session objects run in the MCP server Worker; this isolate authenticates and forwards.
    const mcp = yield* cloudMcp;
    const meter = yield* BillingMeter.pipe(Effect.provide(billing));
    // Each job reports its own failure, so a workflow problem cannot prevent email delivery.
    const workflowReconcile = Effect.flatten(HostedExecutor).pipe(
      Effect.flatMap((sdk) => sdk[WorkflowHost].reconcile),
      Effect.provide(executor),
      reportErrors,
      Effect.scoped,
      Effect.withSpan("job.workflow.reconcile"),
      Effect.catch(() => Effect.logWarning("Workflow queue reconciliation failed")),
    );
    // Membership changes sync seats through durable provisioning jobs. This daily
    // pass only repairs what those jobs cannot see, such as edits made in Autumn.
    const billingReconcile = meter.reconcileSeats.pipe(
      reportErrors,
      Effect.scoped,
      Effect.withSpan("job.billing.reconcile"),
      Effect.catch(() => Effect.logError("Billing seat reconciliation failed")),
    );
    // Repeats the reviewed idle grant data step for grants that became idle since; it does
    // nothing until that step has applied here.
    const agentGrantExpiry = Effect.gen(function* () {
      const sql = yield* Effect.flatten(GroupDatabase);
      yield* expireIdleAgentGrants(auth.agentGrants, "private_hosted").pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
    }).pipe(
      Effect.provide(executor),
      reportErrors,
      Effect.scoped,
      Effect.catch(() => Effect.logWarning("Idle agent grant expiry failed")),
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
    );
    yield* jobs.schedule("17 4 * * *", "billing-reconcile", "agent-grant-expiry");
    const backgroundJobs = {
      "organization-removal": organizationRemovals,
      provisioning: dispatch,
      "data-steps": dataSteps,
      "repository-recovery": repositoryRecovery,
      "schedule-wake": schedules.wake,
      "site-assets": siteAssetRetention,
      "app-domain-heartbeat": appDomains.heartbeat,
      "welcome-emails": welcomeEmails.deliver,
      "workflow-reconcile": workflowReconcile,
      "billing-reconcile": billingReconcile,
      "agent-grant-expiry": agentGrantExpiry,
    } satisfies Record<BackgroundJob, unknown>;

    const egress = yield* cloudEgress;
    const clientMetadata = yield* clientMetadataSetting(auth.origin).pipe(Effect.orDie);
    // Only /openapi.json and preparing the Executor catalog app read the document.
    // Clients and the Executor app call the API at its canonical origin.
    const apiOrigin = auth.resourceOrigins.api[0];
    const document = lazyHostedApiDocument(() => executorCloudApiDocument(apiOrigin));
    // Only framework lookups and the published skills read the large authoring reference.
    const authoring = Effect.promise(() => import("./implementation/executor-authoring.ts")).pipe(
      Effect.map(({ executorAuthoringSkills }) => executorAuthoringSkills),
    );
    const api = cloudApi(document).pipe(
      Layer.provide(frameworkDocumentation(authoring)),
      HttpRouter.provideRequest(yield* cloudSourceFormatter),
      Layer.provide(appUi.dashboard),
      Layer.provide(requestServices(auth.appSessions).layer),
      HttpRouter.provideRequest(catalogLive(document.document, egress, clientMetadata, apiOrigin)),
      Layer.provide(schedules.layer),
      Layer.provide(billing),
      Layer.provide(removals),
      Layer.provide(onboarding),
      Layer.provide(hostedMiddlewareLive),
      // Organization middleware reads the product's removal tombstones when it is built.
      Layer.provide(executor),
      HttpRouter.provideRequest(executor),
      Layer.provide(auth.identity),
      Layer.provide(auth.apiIdentity),
      Layer.provide(auth.mcpIdentity),
    );
    const memoMap = yield* Layer.makeMemoMap;
    // The dashboard API holds most routes and their schema decoders. MCP, auth, telemetry
    // and document requests do not use it, so it is built on its first request and kept
    // for the isolate. Building is synchronous: no other request can see a partial build.
    const buildApi = api.pipe(
      Layer.provide(HttpServer.layerServices),
      HttpRouter.toHttpEffect,
      Effect.provideService(Layer.CurrentMemoMap, memoMap),
    );
    const apiServices = yield* Effect.context<Effect.Services<typeof buildApi>>();
    let apiHandle: Effect.Success<typeof buildApi> | undefined;
    const apiRequest = Effect.suspend(
      () => (apiHandle ??= Effect.runSync(Effect.provideContext(buildApi, apiServices))),
    );
    // Register the API's own paths here, so routing precedence is unchanged. One layer adds
    // them all: a layer per endpoint cost a fresh isolate's first request a layer build each.
    const apiRoutes = HttpRouter.addAll([
      HttpRouter.route("GET", "/openapi.json", apiRequest),
      // A page's reads, started together in the browser, run here in one isolate.
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
      HttpRouter.add("GET", "/.well-known/oauth-protected-resource", mcpProtectedResource),
      HttpRouter.add("GET", "/.well-known/oauth-protected-resource/mcp", mcpProtectedResource),
    ).pipe(HttpRouter.provideRequest(auth.mcpIdentity));
    const apiDiscoveryRoutes = Layer.mergeAll(
      HttpRouter.add("GET", "/api", apiChallenge),
      HttpRouter.add("GET", "/.well-known/oauth-protected-resource/api", apiProtectedResource),
    ).pipe(HttpRouter.provideRequest(auth.apiIdentity));
    const appWebhookRoutes = HttpRouter.add(
      "*",
      "/api/webhooks/:appId/:subscriptionId",
      hostedWebhookCallback,
    ).pipe(HttpRouter.provideRequest(executor));
    const withGitAccess = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
      layer.pipe(
        HttpRouter.provideRequest(hostedAppGitAccess),
        HttpRouter.provideRequest(executor),
        Layer.provide(auth.identity),
        Layer.provide(auth.apiIdentity),
      );
    const authoringRoutes = withGitAccess(Layer.mergeAll(registryRoutes, gitRoutes));
    // Site pages run through the Worker (`worker-first-routes.ts`) and come from the assets.
    // A file the current build lacks may be a retained docs file from an earlier build;
    // anything else the assets do not hold gets the ordinary 404.
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
    // The site's first-party analytics proxy and error tunnel.
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
      // Only asset misses reach these paths: files of builds a page loaded before a deploy.
      ...retainedAssetFolders.map((folder) =>
        HttpRouter.add("GET", `/${folder}/*`, siteAssets.serve),
      ),
      publishedSkillRoutes(authoring),
      siteRoutes,
      siteTelemetryRoutes,
      browserTelemetry.pipe(HttpRouter.provideRequest(auth.identity)),
      HttpRouter.add("GET", "/", homepage(auth.cookiePrefix, dashboard(null))),
      HttpRouter.add("GET", "/org/:organizationSlug", organizationRoot),
      ...dashboardPageRoutes.map((route) =>
        route === "/app-auth"
          ? // Resolved on the server so opening an app never renders an intermediate page.
            HttpRouter.add("GET", route, appUi.signIn(dashboard(null))).pipe(
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
      HttpRouter.add("*", "/api/email/unsubscribe", welcomeEmails.unsubscribe),
      HttpRouter.add("GET", "/api/oauth/callback", hostedOAuthCallback).pipe(
        HttpRouter.provideRequest(auth.identity),
      ),
      HttpRouter.add(
        "GET",
        clientMetadataDocumentPath,
        clientMetadataDocument(clientMetadata),
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
    // Routes are immutable per isolate; requestServices keeps live auth resources in each event.
    const handle = yield* routes.pipe(
      Layer.provide(HttpServer.layerServices),
      HttpRouter.toHttpEffect,
      Effect.provideService(Layer.CurrentMemoMap, memoMap),
    );
    // Each role host has its own router, built from the same route layers, so it can serve no
    // other path. Each build registers its routes in its own router.
    const mcpHost = yield* Layer.mergeAll(
      mcpRoutes,
      authorizationServerRoutes,
      // ChatGPT verifies the domain of the app's MCP URL, now `mcp.`, at this path.
      HttpRouter.add("GET", "/.well-known/openai-apps-challenge", openAiAppsChallenge),
    ).pipe(
      Layer.provide(HttpServer.layerServices),
      HttpRouter.toHttpEffect,
      Effect.provideService(Layer.CurrentMemoMap, memoMap),
    );
    const apiHost = yield* Layer.mergeAll(
      apiRoutes,
      apiDiscoveryRoutes,
      authorizationServerRoutes,
      appWebhookRoutes,
      // The Executor app reads its skills beside the API it calls.
      publishedSkillRoutes(authoring),
      // The public app registry, the SDK's and CLI's default host.
      withGitAccess(registryRoutes),
    ).pipe(
      Layer.provide(HttpServer.layerServices),
      HttpRouter.toHttpEffect,
      Effect.provideService(Layer.CurrentMemoMap, memoMap),
    );
    // The paths v1's edge forwards from `executor.sh`. Issuer metadata is served here, never
    // redirected: clients require the issuer to share an origin with the URL they fetched. A
    // social provider's return answers with a redirect to the browser origin, where the
    // sign-in's state cookie is.
    const edgeHost = yield* Layer.mergeAll(
      authorizationServerRoutes,
      HttpRouter.add("GET", "/api/auth/callback/:provider", redirectTo(auth.origin, 302)),
      // A connected-account sign-in's return opens the browser origin's callback page.
      HttpRouter.add("GET", "/api/oauth/callback", hostedOAuthCallback).pipe(
        HttpRouter.provideRequest(auth.identity),
      ),
      withGitAccess(gitRoutes),
      // The public site. Nobody is signed in to v2 on the edge, so `/` is always the site's.
      HttpRouter.add("GET", "/", staticDocument("/index.html")),
      siteRoutes,
      siteTelemetryRoutes,
      publishedSkillRoutes(authoring),
    ).pipe(
      Layer.provide(HttpServer.layerServices),
      HttpRouter.toHttpEffect,
      Effect.provideService(Layer.CurrentMemoMap, memoMap),
    );
    const roleHosts = withRoleHosts(
      auth.hosts,
      (headers) => hasSessionCookie(new Headers(headers), auth.cookiePrefix),
      { mcp: mcpHost, api: apiHost, edge: edgeHost },
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
        // Server-rendered pages read the API through this complete pipeline, in-process.
        withHostPipeline,
        lifetime.http,
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        // The coordinator calls the retired one once, at handover.
        PlacedScheduleCoordinatorLive.pipe(Layer.provideMerge(ScheduleCoordinatorLive)),
        OrganizationRemovalRecoveryLive,
        cloudAuthDatabase,
        cloudTelemetry,
        Cloudflare.Workers.CronEventSourceLive,
      ),
    ),
  ),
);
