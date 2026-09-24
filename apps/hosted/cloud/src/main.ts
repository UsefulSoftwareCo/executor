import { cloudArtifactsTokensLive } from "./infrastructure/artifacts-tokens.ts";
import { Provisioning, dispatchProvisioning } from "./infrastructure/provisioning.ts";
import { previewLifetime } from "./infrastructure/test-stage-expiry.ts";
import { executorCloudApiDocument } from "./contracts/api.ts";
import { hostedAppUi, appAddresses } from "@executor-js/hosted-server/app-ui";
import { cloudAppUiBase } from "./contracts/app-ui.ts";
import { AppDomainCoordinatorLive, cloudAppDomains } from "./infrastructure/app-domains.ts";
import { AppRepositoryRecovery, WorkflowHost } from "@executor-js/sdk/core";
import { AppWorkflows } from "./infrastructure/workflows.ts";
import {
  OrganizationRemoval,
  dispatchOrganizationRemovals,
} from "./infrastructure/organization-removal-workflow.ts";
import { HostedExecutor } from "@executor-js/hosted-server";
import { BillingMeter } from "./contracts/billing-meter.ts";
import { ExecutionAdmission } from "@executor-js/hosted-server";
import { billingBindings } from "./infrastructure/billing.ts";
import { registryRoutes, gitRoutes } from "@executor-js/app-management";
import { hostedAppGitAccess } from "@executor-js/hosted-server/app-management";
/** Cloudflare composition edge. Alchemy owns the Effect runtime and request scopes. */
import { executorSkillFiles, publishedSkillRoutes } from "@executor-js/app-templates/executor";
import authoring from "../.generated/executor-authoring.json" with { type: "json" };
import { hideRemovedOrganizations } from "./implementation/organization-removal.ts";
import {
  browserTelemetry,
  hostedOAuthCallback,
  hostedWebhookCallback,
  catalogLive,
  requireUserLive,
  requireOrganizationLive,
  mcpProtectedResource,
  mcpAuthorizationServer,
  apiChallenge,
  apiProtectedResource,
} from "@executor-js/hosted-server";
import * as Cloudflare from "alchemy/Cloudflare";
import { cloudSite } from "./infrastructure/site.ts";
import * as Output from "alchemy/Output";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { Config, Effect, Layer, Option, Path } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { cloudAuth } from "./infrastructure/auth.ts";
import { cloudOnboarding } from "./infrastructure/onboarding.ts";
import { cloudMcp, McpSessionsLive } from "./infrastructure/mcp.ts";
import { cloudApi } from "./implementation/api.ts";
import { billingLive } from "./implementation/billing.ts";
import { cloudSchedules, ScheduleCoordinatorLive } from "./infrastructure/schedules.ts";
import { cloudEgress, cloudExecutor } from "./infrastructure/executor.ts";
import { cloudAuthDatabase } from "./infrastructure/auth-database.ts";
import {
  cloudObservability,
  cloudTelemetry,
  telemetryBindings,
} from "./infrastructure/telemetry.ts";
import { cloudEmail } from "./infrastructure/email.ts";
import { cloudWelcomeEmails } from "./infrastructure/welcome-email.ts";
import { cloudEntryApi, cloudEntryDocument, resolveCloudEntry } from "./implementation/entry.ts";
import { browserReturnTo } from "@executor-js/hosted-server/browser/contracts";
import { HttpServerRequest } from "effect/unstable/http";
import { staticDocument } from "./implementation/homepage.ts";
import { homepage } from "./implementation/homepage.ts";
import { postHogBindings } from "./infrastructure/posthog.ts";
import { cloudAnalytics } from "./implementation/product-analytics.ts";
import { sentryWorkerBuild } from "./infrastructure/sentry-build.ts";
import { reportCloudFailure } from "./implementation/error-reporting.ts";
import { sentryBindings } from "./infrastructure/sentry.ts";
import { cloudErrorTunnel } from "./implementation/error-tunnel.ts";
import { cloudSentry } from "./implementation/error-reporting.ts";
import { cloudOrigin } from "./infrastructure/stage.ts";
import { AppDataSupervisor, AppDataSupervisorLive } from "./infrastructure/app-data.ts";
import { cloudDevelopment } from "./contracts/development.ts";
import { requestServices } from "@executor-js/hosted-server";
import { requestTiming } from "@executor-js/telemetry/http";

import { Api } from "./infrastructure/api-worker.ts";
export { Api } from "./infrastructure/api-worker.ts";

export default Api.make(
  Effect.gen(function* () {
    // Native Worker props are also evaluated during runtime initialization.
    // The build-time flag also lets Rolldown remove provisioning imports.
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };
    const { dev } = yield* AlchemyContext;
    const path = yield* Path.Path;
    const origin = dev ? undefined : new URL(yield* cloudOrigin.pipe(Effect.orDie));
    const placementRegion = yield* Config.NonEmptyString("CLOUD_PLACEMENT_REGION").pipe(
      Config.option,
    );
    const analytics = yield* postHogBindings;
    const sentry = yield* sentryBindings;
    const site = yield* cloudSite;
    return {
      main: import.meta.url,
      ...(yield* cloudObservability),
      env: {
        ...(yield* telemetryBindings),
        ...analytics.env,
        CLOUDFLARE_ACCOUNT_ID: yield* Config.String("CLOUDFLARE_ACCOUNT_ID"),
        ...sentry.env,
        ...(yield* billingBindings),
      },
      build: sentryWorkerBuild("api"),
      // Auth callbacks and the dashboard share the configured canonical origin.
      ...(origin === undefined ? {} : { domain: origin.hostname }),
      // Opt in per deployment; the database's cloud region is a proximity hint,
      // not a Cloudflare data center or a change to local development routing.
      ...(dev
        ? {}
        : Option.match(placementRegion, {
            onNone: () => ({}),
            onSome: (region) => ({ placement: { region } }),
          })),
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
        notFoundHandling: "none",
        // Preserve TanStack paths after an internal index.html rewrite.
        htmlHandling: "none",
        // An allowlist, so everything else is served from the assets. The
        // documentation under /docs and /docs/* is static and must stay off
        // this list.
        runWorkerFirst: [
          "/",
          "/login",
          "/login/",
          "/login/sso",
          "/login/sso/",
          "/create",
          "/create/",
          "/api",
          "/api/*",
          "/health",
          "/openapi.json",
          "/mcp",
          "/org/*/mcp",
          "/git/*",
          "/.well-known/*",
        ],
        // Vite emits _redirects from the TanStack route tree; Alchemy reads it.
      },
    };
  }),
  Effect.gen(function* () {
    const lifetime = yield* previewLifetime;
    const analytics = yield* cloudAnalytics;
    const reportErrors = yield* cloudSentry;
    const errorTunnel = yield* cloudErrorTunnel;
    const email = yield* cloudEmail.pipe(Effect.orDie);
    const auth = yield* cloudAuth(email.send);
    const welcomeEmails = yield* cloudWelcomeEmails(email.welcome);
    yield* AppWorkflows;
    yield* Provisioning;
    yield* OrganizationRemoval;
    const executor = yield* cloudExecutor(
      yield* AppDataSupervisor,
      yield* cloudArtifactsTokensLive,
    );
    const schedules = yield* cloudSchedules;
    const dispatch = dispatchProvisioning.pipe(
      Effect.provide(executor),
      // A request finalizer runs after its SQL pool closes. Dispatch owns a
      // fresh scope so execution memos cannot reuse that closed pool.
      Effect.scoped,
      Effect.withSpan("job.provisioning.dispatch"),
      Effect.catch(() => Effect.logWarning("Provisioning outbox unavailable")),
    );
    yield* Cloudflare.Workers.cron("* * * * *", () =>
      dispatchOrganizationRemovals.pipe(
        Effect.provide(executor),
        Effect.scoped,
        Effect.catch(() => Effect.logWarning("Organization removal journal unavailable")),
        lifetime.background,
      ),
    );
    yield* Cloudflare.Workers.cron("* * * * *", () => dispatch.pipe(lifetime.background));
    yield* Cloudflare.Workers.cron("* * * * *", () =>
      Effect.flatten(AppRepositoryRecovery).pipe(
        Effect.provide(executor),
        reportErrors,
        Effect.scoped,
        Effect.withSpan("job.repository.recover"),
        Effect.catch(() => Effect.logWarning("App repository recovery failed")),
        lifetime.background,
      ),
    );
    const appDomains = yield* cloudAppDomains;
    const appUi = hostedAppUi(
      appAddresses(auth.origin, yield* cloudAppUiBase.pipe(Effect.orDie)),
      appDomains.status,
    );
    const mcp = yield* cloudMcp;
    const billing = yield* billingLive.pipe(Effect.orDie);
    const meter = yield* BillingMeter.pipe(Effect.provide(billing));
    // One established schedule owns both independent background jobs. Each job
    // reports its own failure so billing cannot prevent optional email delivery.
    yield* Cloudflare.Workers.cron("*/5 * * * *", () =>
      Effect.all(
        [
          welcomeEmails.deliver,
          Effect.flatten(HostedExecutor).pipe(
            Effect.flatMap((sdk) => sdk[WorkflowHost].reconcile),
            Effect.provide(executor),
            reportErrors,
            Effect.scoped,
            Effect.withSpan("job.workflow.reconcile"),
            Effect.catch(() => Effect.logWarning("Workflow queue reconciliation failed")),
          ),
          meter.reconcileSeats.pipe(
            reportErrors,
            Effect.scoped,
            Effect.withSpan("job.billing.reconcile"),
            Effect.catch(() => Effect.logError("Billing seat reconciliation failed")),
          ),
        ],
        { concurrency: 2, discard: true },
      ).pipe(lifetime.background),
    );

    const onboarding = yield* cloudOnboarding.pipe(Effect.orDie);
    const egress = yield* cloudEgress;
    const document = executorCloudApiDocument(auth.origin);
    const api = cloudApi(document).pipe(
      Layer.provide(appUi.dashboard),
      Layer.provide(requestServices(auth.appSessions).layer),
      HttpRouter.provideRequest(catalogLive(executorSkillFiles(authoring), document, egress)),
      Layer.provide(schedules),
      Layer.provide(billing),
      Layer.provide(Layer.succeed(ExecutionAdmission, meter.consume)),
      Layer.provide(onboarding),
      Layer.provide(requireUserLive),
      Layer.provide(requireOrganizationLive),
      HttpRouter.provideRequest(executor),
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
    ).pipe(HttpRouter.provideRequest(auth.mcpIdentity));
    const authoringRoutes = Layer.mergeAll(registryRoutes, gitRoutes).pipe(
      HttpRouter.provideRequest(hostedAppGitAccess),
      HttpRouter.provideRequest(executor),
      Layer.provide(auth.identity),
      Layer.provide(auth.apiIdentity),
    );
    const routes = Layer.mergeAll(
      HttpRouter.add("POST", "/api/internal/app-domains/resume", appDomains.control("resume")),
      HttpRouter.add("POST", "/api/internal/app-domains/drain", appDomains.control("drain")),
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
            staticDocument("/dashboard.html"),
          ),
        ).pipe(HttpRouter.provideRequest(onboarding)),
      ),
      HttpRouter.add("GET", "/api/entry", cloudEntryApi(auth.browserSession)).pipe(
        HttpRouter.provideRequest(onboarding),
      ),
      api,
      publishedSkillRoutes(executorSkillFiles(authoring)),
      HttpRouter.add("*", "/api/:channel/*", analytics.proxy),
      HttpRouter.add("POST", "/api/:channel/submit", errorTunnel),
      browserTelemetry.pipe(HttpRouter.provideRequest(auth.identity)),
      HttpRouter.add("GET", "/", homepage(auth.cookiePrefix, analytics.hero)),
      HttpRouter.add("*", "/api/webhooks/:appId/:subscriptionId", hostedWebhookCallback).pipe(
        HttpRouter.provideRequest(executor),
      ),
      HttpRouter.add(
        "GET",
        "/api/auth/organization/list",
        auth.handler.pipe(Effect.flatMap(hideRemovedOrganizations), Effect.provide(executor)),
      ),
      HttpRouter.add("*", "/api/auth/*", auth.handler),
      HttpRouter.add("*", "/api/email/unsubscribe", welcomeEmails.unsubscribe),
      HttpRouter.add("GET", "/api/oauth/callback", hostedOAuthCallback).pipe(
        HttpRouter.provideRequest(auth.identity),
      ),
      mcpRoutes,
      Layer.mergeAll(
        HttpRouter.add("GET", "/api/mcp/approvals/:requestId", mcp.approvals),
        HttpRouter.add("POST", "/api/mcp/approvals/:requestId", mcp.approvals),
      ).pipe(HttpRouter.provideRequest(auth.mcpIdentity)),
      Layer.mergeAll(
        HttpRouter.add("GET", "/api", apiChallenge),
        HttpRouter.add("GET", "/.well-known/oauth-protected-resource/api", apiProtectedResource),
      ).pipe(HttpRouter.provideRequest(auth.apiIdentity)),
    );
    // Routes are immutable per isolate; requestServices keeps live auth resources in each event.
    const handle = yield* routes.pipe(
      Layer.provide(HttpServer.layerServices),
      HttpRouter.toHttpEffect,
      Effect.provideService(Layer.CurrentMemoMap, yield* Layer.makeMemoMap),
    );
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        // Streamed responses close their HTTP scope before delivering EOF.
        // Dispatch has its own scope and must not hold that EOF until background work finishes.
        // Cron recovers dispatch if the request ends before this finalizer runs.
        if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
          const execution = yield* Cloudflare.WorkerExecutionContext;
          yield* Effect.addFinalizer(() =>
            execution.waitUntil(
              dispatch.pipe(lifetime.background, Effect.timeoutOption("10 seconds"), Effect.asVoid),
            ),
          );
        }
        return yield* handle;
      }).pipe(
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
        reportErrors,
        requestTiming,
        lifetime.http,
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AppDataSupervisorLive,
        McpSessionsLive,
        ScheduleCoordinatorLive,
        AppDomainCoordinatorLive,
        cloudAuthDatabase,
        cloudTelemetry,
        Cloudflare.Workers.CronEventSourceLive,
      ),
    ),
  ),
);
