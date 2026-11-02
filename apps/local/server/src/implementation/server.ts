import { localWorkflowInputHandlers } from "./workflow-inputs.ts";
import { localSourceFormatter } from "@executor-js/app-management/source-format";
import {
  publishedSkillRoutes,
  readExecutorSkills,
  annotateSkillRead,
} from "@executor-js/app-templates/executor";
import { localAppBrowserHandlers } from "./app-browser.ts";
import { accountChoiceRejections } from "./account-choice.ts";
import { startupPhase } from "./startup-diagnostics.ts";
import {
  startScheduleWorker,
  defaultScheduleWorkerOptions,
  ScheduleObservation,
  deliverEvents,
} from "@executor-js/sdk/scheduling";
import { localScheduleHandlers } from "./schedules.ts";
import { localMcpApproval } from "./mcp-approvals.ts";
import { makeLocalMcpOAuth, type LocalMcpOAuth } from "./mcp-oauth.ts";
import { localEventAuthority } from "./events.ts";
import { localMcpConnectionHandlers } from "./mcp-connections.ts";
import { localAppManagement } from "./app-management.ts";
import {
  expireIdleAgentGrants,
  runStartupDataSteps,
  type LocalOwnerMigration,
} from "@executor-js/app-management/data-steps";
import { SqlClient } from "effect/sql";

/** Local host composition. The SDK owns operations; this package owns local resources and access. */
import {
  WorkflowHost,
  RepositoryHost,
  type Executor,
  AccountNotFound,
  AppNotFound,
  createExecutor,
  httpEventSender,
  makeDeclarationCache,
  declarationConfig,
  toEffectRuntime,
  executorHandlers,
  webhookCallback,
  CurrentActor,
  hostedExecutorOrigin,
  remoteRegistry,
  requestRejections,
} from "@executor-js/sdk/core";
import { filesystemBlobStore, workerdApps } from "@executor-js/sdk/node";
import { officialCatalogUrl } from "@executor-js/catalog";
import {
  Config,
  Effect,
  Layer,
  Option,
  Path,
  Ref,
  Result,
  Deferred,
  Schedule,
  Scope,
  Stream,
} from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { recordRequestRejections, requestTiming } from "@executor-js/telemetry/http";
import { safeHttpClient } from "@executor-js/utils/safe-fetch";
import type { HostEgress } from "@executor-js/utils/url-policy";
import { HttpApiBuilder } from "effect/http-api";
import type { LocalServerOptions } from "../contracts/server.ts";
import type { ServerConfig } from "../contracts/config.ts";
import { openStorage } from "./storage.ts";
import { installExecutorApp } from "./executor-app.ts";
import { localSkills } from "./app-browser.ts";
import { localMcp } from "./mcp.ts";
import { dashboard } from "./dashboard.ts";
import { makeLocalAuth, authHandlers, localBearer, type LocalAuth } from "./auth.ts";
import { LocalWebhookSetupApi } from "../contracts/webhook-setup.ts";
import { localWebhookSetupHandlers } from "./webhook-setup.ts";
import { DesktopReturnApi } from "../contracts/desktop-return.ts";
import { makeDesktopReturns } from "./desktop-return.ts";
import { accountConnectHandlers, connectForApp } from "./account-connections.ts";
import { localOwner, localOwners } from "./owners.ts";
import { appUi } from "./app-ui.ts";
import { appAuthentication, appRequest } from "./app-auth.ts";
import { appFromHost } from "../contracts/app-ui.ts";
import { AppUiApi } from "apps/ui/contracts";
import { appSignInCallbackPath } from "apps/ui/auth";
import { DashboardApi, OAuthCallbackPath } from "../contracts/dashboard.ts";
import { LocalAuthApi } from "../contracts/auth.ts";
import { AccountConnectApi } from "../contracts/account-connections.ts";
import { browserTelemetry } from "./telemetry.ts";
import { webFiles } from "./web.ts";
import { withHostPipeline } from "@executor-js/dashboard-start/in-process";
import { layerBuildHeader } from "@executor-js/dashboard-start/build-header";
import { LocalExecutorApi, localManagementDocument } from "../contracts/management.ts";
import { bundledGit, nativeRepositories, systemGit } from "@executor-js/app-source/node";
import { feedbackDisabled } from "@executor-js/telemetry/product-analytics";
import { LocalFeedbackApi } from "../contracts/feedback.ts";
import { localAnalytics, observeLocalExecutor, scheduleAnalytics } from "./product-analytics.ts";
import {
  linkedOperation,
  localActor,
  localAppCopies,
  localResourceLifecycle,
} from "./app-accounts.ts";
import { profileAccounts } from "./mcp-auth-profiles.ts";

/** Initialize local persistence and compose the API, without choosing a socket implementation. */
/** Skill reads that record which Executor app skill was read. */
const annotatedSkillReads = (skills: Executor["skills"]): Executor["skills"] => ({
  ...skills,
  read: (input) => skills.read(input).pipe(Effect.tap(annotateSkillRead)),
});

export const localApi = (
  config: ServerConfig,
  crypto: Crypto,
  existingAuth: LocalAuth | undefined,
  options: LocalServerOptions,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const auth = existingAuth ?? (yield* makeLocalAuth(crypto, config.directory));
      const path = yield* Path.Path;
      const directory = path.resolve(config.directory);
      const { storage, sql } = yield* openStorage(directory);
      // Node can hook connect, so every host-side fetch re-checks the addresses a name resolves
      // to. The agent lives for this layer's scope, which is the process.
      const httpClient = yield* safeHttpClient(config.urlPolicy);
      const egress: HostEgress = { policy: config.urlPolicy, client: httpClient };
      const blobs = filesystemBlobStore({ directory: path.join(directory, "builds") });
      const ready = yield* Deferred.make<Executor>();
      const { runtime, workflows, declarations } = yield* workerdApps({
        directory: path.join(directory, "workerd"),
        blobs,
        executor: Deferred.await(ready),
        legacyDataDirectories: [
          path.join(directory, "app-data"),
          path.join(directory, "workflow-engine"),
        ],
        // The bundled Executor app calls this process on 127.0.0.1, and local development
        // routinely targets a service on the operator's own machine.
        allowPrivateAppFetch: true,
        encryptionKey: config.encryptionKey,
        ...Option.match(yield* Config.String("EXECUTOR_NPM_REGISTRY").pipe(Config.option), {
          onNone: () => ({}),
          onSome: (registry) => ({ npmRegistry: registry }),
        }),
      }).pipe(startupPhase("runtime"));
      const registry = remoteRegistry(
        yield* Config.String("EXECUTOR_REGISTRY_URL").pipe(
          Config.withDefault(hostedExecutorOrigin),
        ),
      );
      // A release names the Git it bundles; a source checkout uses the Git on PATH.
      const git = Option.match(
        yield* Config.NonEmptyString("EXECUTOR_GIT_DIRECTORY").pipe(Config.option),
        { onNone: () => systemGit, onSome: bundledGit },
      );
      const repositories = nativeRepositories(path.join(directory, "repositories"), git);
      const server = yield* Scope.Scope;
      const evaluation = yield* declarationConfig;
      // MCP grants are checked again before each event delivery; OAuth starts after the executor.
      const grants = yield* Deferred.make<LocalMcpOAuth>();
      const executor = yield* createExecutor({
        database: storage,
        secret: config.encryptionKey,
        origin: config.webhookOrigin ?? config.browserOrigin ?? `http://localhost:${config.port}`,
        git: repositories,
        hooks: localResourceLifecycle(Deferred.await(ready), sql),
        blobs,
        runtime,
        workflows,
        workflowInputUrl: ({ app, id }) =>
          `${config.browserOrigin ?? `http://localhost:${config.port}`}/approvals/workflow/${encodeURIComponent(app)}/${encodeURIComponent(id)}`,
        registry,
        cache: {
          memory: makeDeclarationCache(evaluation.limits),
          // Kept in each app's supervisor too, so a restart does not evaluate every app again.
          durable: declarations,
          toolListings: evaluation.toolListings,
        },
        // Stale declarations refresh on the server's own lifetime.
        background: (work) => Effect.forkIn(work, server).pipe(Effect.as(true)),
        events: {
          sender: httpEventSender(egress),
          authorize: localEventAuthority(Deferred.await(grants)),
          allowInsecureCallbacks: config.urlPolicy.allowLoopbackHttp,
        },
        oauth: {
          httpClient,
          clientName: "Executor Local",
          urlPolicy: config.urlPolicy,
          ...(config.oauthClientMetadataUrl === undefined
            ? {}
            : { clientMetadataUrl: config.oauthClientMetadataUrl }),
        },
      }).pipe(startupPhase("sdk"));
      yield* Deferred.succeed(ready, executor);
      const analytics = yield* localAnalytics({
        directory,
        product: options.product,
        platform: options.platform ?? { os: "unknown", arch: "unknown" },
        sql,
      });
      /** Each product surface records its own use; host-owned work uses the plain executor. */
      const observed = (source: "mcp" | "api" | "dashboard" | "app_ui") =>
        observeLocalExecutor(executor, analytics, source);
      // Data steps revoke idle OAuth grants, so the provider exists before they run.
      const oauth = yield* makeLocalMcpOAuth(
        config,
        auth,
        crypto,
        profileAccounts.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      );
      // Before background work, the Executor app's regeneration and serving; the data lock is held.
      // Data step 7 records why it did not move other owners' records; the dashboard shows it.
      const ownerMigration = yield* Ref.make<LocalOwnerMigration | null>(null);
      yield* runStartupDataSteps(
        {
          executor,
          blobs,
          agentGrants: oauth.agentGrants,
          appCopies: localAppCopies(sql, executor),
          localOwners: {
            owner: localOwner,
            kept: localOwners,
            storage: storage.version,
            status: (status) => Ref.set(ownerMigration, status),
          },
        },
        "private_local",
      ).pipe(Effect.provideService(SqlClient.SqlClient, sql), startupPhase("data-steps"));
      // Once the idle grant step has applied, revoke grants that became idle since, daily.
      yield* Effect.forkScoped(
        expireIdleAgentGrants(oauth.agentGrants, "private_local").pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.catch(() => Effect.logWarning("Idle agent grant expiry failed")),
          Effect.repeat(Schedule.spaced("1 day")),
        ),
      );
      yield* Effect.forkScoped(
        executor[RepositoryHost].recover.pipe(
          Effect.catch(() => Effect.logWarning("App repository recovery failed")),
          Effect.repeat(Schedule.spaced("10 seconds")),
        ),
      );
      yield* Effect.forkScoped(
        executor[WorkflowHost].reconcile.pipe(
          Effect.catch(() => Effect.logWarning("Workflow queue reconciliation failed")),
          Effect.repeat(Schedule.spaced("5 seconds")),
        ),
      );
      const scheduleConcurrency = yield* Config.Number("EXECUTOR_SCHEDULE_CONCURRENCY").pipe(
        Config.withDefault(defaultScheduleWorkerOptions.concurrency),
      );
      const scheduler = startScheduleWorker(executor, () => Effect.void, {
        ...defaultScheduleWorkerOptions,
        runner: "local",
        concurrency: scheduleConcurrency,
      });
      // The worker's polling fibers inherit the observer it starts with.
      const { wakeWebhookSources } = yield* analytics === undefined
        ? scheduler
        : scheduler.pipe(Effect.provideService(ScheduleObservation, scheduleAnalytics(analytics)));
      const managed = yield* installExecutorApp(executor, sql, config);
      const access = HttpRouter.middleware((httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          // Browser reads use the separate dashboard API; these routes remain programmatic.
          if (request.headers.origin !== undefined)
            return HttpServerResponse.empty({ status: 403 });
          if (!localBearer(config, request.headers.authorization)) {
            return HttpServerResponse.empty({ status: 401 });
          }
          const pathname = yield* Effect.try(() =>
            decodeURIComponent(new URL(request.url, "http://localhost").pathname),
          ).pipe(Effect.result);
          if (Result.isFailure(pathname)) return HttpServerResponse.empty({ status: 400 });
          const target = pathname.success.replace(/\/$/, "");
          // SDK review primitives are only delivered through the product's browser session routes.
          if (
            /^\/v1\/scheduled-runs\/[^/]+\/approval$/.test(target) ||
            /^\/v1\/apps\/[^/]+\/workflow-inputs\/[^/]+\/answer$/.test(target)
          )
            return HttpServerResponse.empty({ status: 403 });
          // Product protection stays at the host boundary, not in the reusable SDK.
          if (request.method !== "GET" && request.method !== "HEAD") {
            if (
              (request.method === "DELETE" && target === `/v1/apps/${managed.app}`) ||
              (request.method === "PATCH" && target === `/v1/apps/${managed.app}/name`)
            )
              return HttpServerResponse.empty({ status: 403 });
            if (
              target === `/v1/accounts/${managed.account}` ||
              target.startsWith(`/v1/accounts/${managed.account}/`)
            )
              return HttpServerResponse.empty({ status: 403 });
          }
          return yield* httpEffect;
        }),
      );
      yield* Deferred.succeed(grants, oauth);
      yield* Effect.forkScoped(deliverEvents(executor));
      const mcp = yield* localMcp(sql, observed("mcp"), config.mcp, config, oauth);
      const api = observed("api");
      // Callers never choose accounts; the served operations use the accounts linked to the app.
      const linked = linkedOperation(sql, api);
      const programmatic = Layer.mergeAll(
        HttpRouter.add(
          "GET",
          "/openapi.json",
          HttpServerResponse.jsonUnsafe(localManagementDocument()),
        ),
        HttpApiBuilder.layer(LocalExecutorApi).pipe(
          Layer.provide(
            executorHandlers({
              ...api,
              tools: {
                ...api.tools,
                list: linked(api.tools.list),
                index: linked(api.tools.index),
                get: linked(api.tools.get),
                call: linked(api.tools.call),
              },
              // The apps CLI reads skills here, as MCP does. The Executor app's skills.read tool
              // reads here too, not through the MCP skills tool.
              skills: annotatedSkillReads(localSkills(sql, api)),
              appData: {
                ...api.appData,
                query: linked(api.appData.query),
                mutate: linked(api.appData.mutate),
                // The route streams its failures, resolving the accounts too.
                subscribe: (input) =>
                  Effect.succeed(Stream.unwrap(linked(api.appData.subscribe)(input))),
              },
              schedules: {
                ...api.schedules,
                // Each declaration carries the local subject's copy.
                definitions: (input) =>
                  linked(api.schedules.definitions)({ ...input, actor: localActor }),
              },
              webhooks: { ...api.webhooks, definitions: linked(api.webhooks.definitions) },
              // Local assigns owners itself: new apps and OAuth clients belong to the local user,
              // and connected accounts to their app's owner, whatever owner the caller names.
              apps: {
                ...api.apps,
                workflows: { ...api.apps.workflows, list: linked(api.apps.workflows.list) },
                workflowRuns: {
                  ...api.apps.workflowRuns,
                  start: linked(api.apps.workflowRuns.start),
                },
                create: (input) => api.apps.create({ ...input, owner: localOwner }),
                copy: (input) => api.apps.copy({ ...input, owner: localOwner }),
                deploy: (input) =>
                  api.apps.deploy(
                    input.app === undefined ? { ...input, owner: localOwner } : input,
                  ),
              },
              oauthClients: {
                ...api.oauthClients,
                register: (input) => api.oauthClients.register({ ...input, owner: localOwner }),
              },
              accountConnections: {
                ...api.accountConnections,
                create: (input) => {
                  if (input.account === managed.account)
                    return Effect.fail(new AccountNotFound({ account: input.account }));
                  if (input.target.app === managed.app)
                    return Effect.fail(new AppNotFound({ app: input.target.app }));
                  return connectForApp(executor, managed.app, input);
                },
              },
            }),
          ),
          // A choice the contract cannot decode is refused as a decoded one is.
          Layer.provide(accountChoiceRejections),
        ),
        HttpApiBuilder.layer(LocalFeedbackApi).pipe(
          Layer.provide(
            HttpApiBuilder.group(LocalFeedbackApi, "feedback", (handlers) =>
              Effect.succeed(
                handlers.handle("submit", ({ payload }) =>
                  analytics === undefined
                    ? Effect.fail(feedbackDisabled())
                    : analytics
                        .submit("feedback_submitted", { message: payload.message })
                        .pipe(Effect.as({ status: "accepted" as const })),
                ),
              ),
            ),
          ),
        ),
      ).pipe(Layer.provide(access.layer));
      const signIn = yield* appAuthentication(executor, auth, config, crypto);
      const ui = appUi(
        observed("app_ui"),
        sql,
        storage.reactivity,
        toEffectRuntime(runtime, blobs),
        config,
        auth,
        signIn.begin,
      );
      const privateResponses = HttpRouter.middleware((response) =>
        response.pipe(
          Effect.map((response) =>
            response.pipe(
              HttpServerResponse.setHeader("cache-control", "no-store"),
              HttpServerResponse.setHeader("referrer-policy", "no-referrer"),
            ),
          ),
        ),
      );
      const appOriginAccess = HttpRouter.middleware((response) =>
        appRequest(config.port).pipe(
          Effect.result,
          Effect.flatMap((access) =>
            Result.isFailure(access)
              ? Effect.succeed(HttpServerResponse.jsonUnsafe(access.failure, { status: 403 }))
              : response,
          ),
        ),
      );
      const notFound = HttpServerResponse.empty({ status: 404 });
      // App-host routes: typed APIs plus explicit browser, asset and SPA handlers.
      const appRoutes = Layer.mergeAll(
        HttpApiBuilder.layer(AppUiApi).pipe(
          Layer.provide(ui.api),
          Layer.provide(ui.authenticated.layer),
        ),
        HttpRouter.add("POST", "/_executor/api/telemetry/traces", ui.telemetry("traces")),
        HttpRouter.add("POST", "/_executor/api/telemetry/logs", ui.telemetry("logs")),
        HttpRouter.add("GET", appSignInCallbackPath, signIn.callback),
        HttpRouter.add("GET", "/_executor/version", ui.versions),
        HttpRouter.add("GET", "/_executor/watch.js", ui.watch),
        HttpRouter.add("GET", "/_executor/assets/:version/*", ui.asset),
        // Keep the GET/HEAD SPA fallback out of host-owned namespaces. Unregistered methods already return 404.
        HttpRouter.add("GET", "/_executor/*", notFound),
        HttpRouter.add("GET", "/dashboard/*", notFound),
        HttpRouter.add("GET", "/auth/*", notFound),
        HttpRouter.add("GET", "/v1/*", notFound),
        HttpRouter.add("GET", "/mcp/*", notFound),
        HttpRouter.add("GET", "*", ui.page),
      ).pipe(Layer.provide(appOriginAccess.layer), Layer.provide(privateResponses.layer));
      const dashboardApi = dashboard(
        observed("dashboard"),
        sql,
        storage.reactivity,
        config,
        auth,
        egress,
        {
          catalogFeedUrl: yield* Config.String("EXECUTOR_CATALOG_URL").pipe(
            Config.withDefault(officialCatalogUrl),
          ),
          managedApp: managed.app,
          managedAccount: managed.account,
          ownerMigration: Ref.get(ownerMigration),
          wakeWebhookSources,
        },
      );
      const web = options.web ?? (yield* webFiles);
      // Executor desktop asks for the callbacks of the OAuth authorizations it opens in a browser.
      const desktopReturns = yield* makeDesktopReturns(config);
      // Dashboard-host routes never include the app-origin APIs.
      const publicSkills = yield* readExecutorSkills;
      const authoring = yield* localAppManagement(
        config,
        auth,
        managed.app,
        { executor: api },
        publicSkills,
      );
      const productRoutes = Layer.mergeAll(
        // Dashboard pages compare this with their own build to notice an upgrade.
        layerBuildHeader,
        publishedSkillRoutes(Effect.succeed(publicSkills)),
        HttpApiBuilder.layer(LocalWebhookSetupApi).pipe(
          Layer.provide(localWebhookSetupHandlers(executor, config, auth, wakeWebhookSources)),
        ),
        HttpApiBuilder.layer(DesktopReturnApi).pipe(Layer.provide(desktopReturns.handlers)),
        HttpRouter.add("*", "/api/webhooks/:appId/:subscriptionId", webhookCallback(executor)),
        authoring,
        options.devtools === undefined ? Layer.empty : options.devtools(auth, config),
        HttpRouter.add(
          "POST",
          "/dashboard/api/telemetry/traces",
          browserTelemetry(config, "traces"),
        ),
        HttpRouter.add("POST", "/dashboard/api/telemetry/logs", browserTelemetry(config, "logs")),
        programmatic,
        HttpRouter.add("*", "/mcp", mcp.http),
        HttpRouter.add("*", "/api/auth/*", oauth.handler),
        HttpRouter.add("GET", "/.well-known/oauth-protected-resource", oauth.protectedResource),
        HttpRouter.add("GET", "/.well-known/oauth-protected-resource/mcp", oauth.protectedResource),
        HttpRouter.add("GET", "/.well-known/oauth-authorization-server", oauth.metadata),
        HttpRouter.add("GET", "/.well-known/oauth-authorization-server/api/auth", oauth.metadata),
        HttpRouter.add("GET", "/mcp/authorize", web.document),
        HttpRouter.add("GET", "/mcp/approve/:requestId", web.document),
        HttpRouter.add(
          "GET",
          "/dashboard/api/mcp/approvals/:requestId",
          localMcpApproval(mcp.approvals, auth, config, sql, executor, oauth),
        ),
        HttpRouter.add(
          "POST",
          "/dashboard/api/mcp/approvals/:requestId",
          localMcpApproval(mcp.approvals, auth, config, sql, executor, oauth),
        ),
        HttpApiBuilder.layer(AccountConnectApi).pipe(
          Layer.provide(accountConnectHandlers(observed("dashboard"), config, crypto, managed)),
          Layer.provide(privateResponses.layer),
        ),
        HttpApiBuilder.layer(DashboardApi).pipe(
          Layer.provide(dashboardApi.handlers),
          Layer.provide(localScheduleHandlers(executor, sql, config, auth)),
          Layer.provide(localWorkflowInputHandlers(executor, config, auth)),
          Layer.provide(localAppBrowserHandlers(executor, sql)),
          Layer.provide(localMcpConnectionHandlers(executor, sql, oauth)),
          Layer.provide(dashboardApi.access),
          HttpRouter.provideRequest(localSourceFormatter),
        ),
        HttpApiBuilder.layer(LocalAuthApi).pipe(
          Layer.provide(authHandlers(auth, config)),
          Layer.provide(privateResponses.layer),
        ),
        HttpRouter.add("GET", "/", web.document),
        HttpRouter.add("GET", "/apps", web.document),
        HttpRouter.add("GET", "/apps/:app", web.document),
        HttpRouter.add("GET", "/app-auth", signIn.signIn(web.document)),
        HttpRouter.add("GET", "/apps/:app/setup", web.document),
        HttpRouter.add("GET", "/apps/:app/delete", web.document),
        HttpRouter.add("GET", "/connections", web.document),
        HttpRouter.add("GET", "/connections/:connection", web.document),
        HttpRouter.add("GET", "/approvals", web.document),
        HttpRouter.add("GET", "/approvals/:run", web.document),
        HttpRouter.add("GET", "/approvals/workflow/:app/:input", web.document),
        HttpRouter.add("GET", "/account-connect/:connection", web.document),
        HttpRouter.add("GET", "/accounts", web.document),
        HttpRouter.add("GET", "/accounts/:account", web.document),
        HttpRouter.add("GET", "/accounts/:account/disconnect", web.document),
        // Manual webhook setup links issued to agents open this dashboard page.
        HttpRouter.add("GET", "/webhooks/:app/:subscription", web.document),
        HttpRouter.add("GET", OAuthCallbackPath, desktopReturns.callback(web.document)),
        HttpRouter.add("GET", "/favicon.png", web.favicon),
        HttpRouter.add("GET", "/assets/:name", web.asset),
        HttpRouter.add("GET", "*", web.fallback),
        // Every product API answers a request its schema rejects with `RequestInvalid`.
      ).pipe(Layer.provide(requestRejections));
      // Each virtual host needs its own router, not the enclosing server's memoized router service.
      const appHandler = yield* HttpRouter.toHttpEffect(appRoutes).pipe(
        Effect.provideService(Layer.CurrentMemoMap, yield* Layer.makeMemoMap),
      );
      const productHandler = yield* HttpRouter.toHttpEffect(productRoutes).pipe(
        Effect.provideService(Layer.CurrentMemoMap, yield* Layer.makeMemoMap),
      );
      // Only hostname selection is custom. Each host's Effect router handles methods, paths and params.
      return HttpRouter.add(
        "*",
        "*",
        // Server-rendered pages read the product API through this same dispatch, in-process.
        withHostPipeline(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            return yield* appFromHost(request.headers.host, config.port) === undefined
              ? productHandler
              : appHandler.pipe(requestTiming);
          }).pipe(
            recordRequestRejections,
            // Every request acts as the one local subject; background work runs as its saved actor.
            Effect.provideService(CurrentActor, localActor),
          ),
        ),
      );
    }),
  );
