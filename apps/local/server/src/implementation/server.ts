import { localSourceFormatter } from "@executor-js/app-management/source-format";
import { mcpWhoamiPath } from "@executor-js/mcp-auth";
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
import { markdownRefusals } from "@executor-js/sdk/markdown";
import { catalogFeedSetting } from "@executor-js/catalog";
import {
  Config,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
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
import {
  makeLocalAuth,
  authHandlers,
  localBearer,
  localRequest,
  requestOrigin,
  type LocalAuth,
} from "./auth.ts";
import { LocalWebhookSetupApi } from "../contracts/webhook-setup.ts";
import { localWebhookSetupHandlers } from "./webhook-setup.ts";
import { DesktopReturnApi } from "../contracts/desktop-return.ts";
import { makeDesktopReturns } from "./desktop-return.ts";
import { accountConnectHandlers, connectForApp } from "./account-connections.ts";
import { localOwner, localOwners } from "./owners.ts";
import { appUi } from "./app-ui.ts";
import { appAuthentication, appRequest } from "./app-auth.ts";
import { appFromHost } from "../contracts/app-ui.ts";
import {
  AppUiApi,
  appIconRoute,
  appMenuBarRoute,
  executorServerIdentityPath,
  type ExecutorServerIdentity,
} from "apps/ui/contracts";
import {
  sameOrigins,
  serverIdentity,
  serverIdentityResponse,
} from "@executor-js/utils/server-identity";
import { appSignInCallbackPath } from "apps/ui/auth";
import { DashboardApi, OAuthCallbackPath } from "../contracts/dashboard.ts";
import { LocalAuthApi, LocalConfigurationError, LocalInstallation } from "../contracts/auth.ts";
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

const annotatedSkillReads = (skills: Executor["skills"]): Executor["skills"] => ({
  ...skills,
  read: (input) => skills.read(input).pipe(Effect.tap(annotateSkillRead)),
});

const installationIdentity = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const installation = yield* fs.readFileString(path.join(directory, "installation.json")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(LocalInstallation))),
      Effect.mapError(
        () =>
          new LocalConfigurationError({
            reason: "io",
            message:
              "Executor could not read its installation record, which identifies this server to the desktop app. Check the data directory permissions.",
          }),
      ),
    );
    const identity: Omit<ExecutorServerIdentity, "origins"> = yield* serverIdentity(
      "local",
      installation.id,
    );
    return identity;
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
      const serverId = yield* installationIdentity(directory);
      const { storage, sql } = yield* openStorage(directory);
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
      const git = Option.match(
        yield* Config.NonEmptyString("EXECUTOR_GIT_DIRECTORY").pipe(Config.option),
        { onNone: () => systemGit, onSome: bundledGit },
      );
      const repositories = nativeRepositories(path.join(directory, "repositories"), git);
      const server = yield* Scope.Scope;
      const evaluation = yield* declarationConfig;
      const grants = yield* Deferred.make<LocalMcpOAuth>();
      const executor = yield* createExecutor({
        database: storage,
        secret: config.encryptionKey,
        origin: config.webhookOrigin ?? config.browserOrigin ?? `http://localhost:${config.port}`,
        git: repositories,
        markdown: markdownRefusals,
        hooks: localResourceLifecycle(Deferred.await(ready), sql),
        blobs,
        runtime,
        workflows,
        registry,
        cache: {
          memory: makeDeclarationCache(evaluation.limits),
          durable: declarations,
          toolListings: evaluation.toolListings,
        },
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
      const observed = (source: "mcp" | "api" | "dashboard" | "app_ui") =>
        observeLocalExecutor(executor, analytics, source);
      const oauth = yield* makeLocalMcpOAuth(
        config,
        auth,
        crypto,
        profileAccounts.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      );
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
      const { wakeWebhookSources } = yield* analytics === undefined
        ? scheduler
        : scheduler.pipe(Effect.provideService(ScheduleObservation, scheduleAnalytics(analytics)));
      const managed = yield* installExecutorApp(executor, sql, config);
      const access = HttpRouter.middleware((httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
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
          if (/^\/v1\/scheduled-runs\/[^/]+\/approval$/.test(target))
            return HttpServerResponse.empty({ status: 403 });
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
              skills: annotatedSkillReads(localSkills(sql, api)),
              appData: {
                ...api.appData,
                query: linked(api.appData.query),
                mutate: linked(api.appData.mutate),
                subscribe: (input) =>
                  Effect.succeed(Stream.unwrap(linked(api.appData.subscribe)(input))),
              },
              schedules: {
                ...api.schedules,
                definitions: (input) =>
                  linked(api.schedules.definitions)({ ...input, actor: localActor }),
              },
              webhooks: { ...api.webhooks, definitions: linked(api.webhooks.definitions) },
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
      const appRoutes = Layer.mergeAll(
        HttpApiBuilder.layer(AppUiApi).pipe(
          Layer.provide(ui.api),
          Layer.provide(ui.authenticated.layer),
        ),
        HttpRouter.add("POST", "/_executor/api/telemetry/traces", ui.telemetry("traces")),
        HttpRouter.add("POST", "/_executor/api/telemetry/logs", ui.telemetry("logs")),
        HttpRouter.add("GET", appSignInCallbackPath, signIn.callback),
        HttpRouter.add("GET", "/_executor/version", ui.versions),
        HttpRouter.add("GET", "/_executor/assets/:version/*", ui.asset),
        HttpRouter.add("GET", appMenuBarRoute, ui.menuBar),
        HttpRouter.add("GET", appIconRoute, ui.icon),
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
          catalogFeedUrl: yield* catalogFeedSetting,
          managedApp: managed.app,
          managedAccount: managed.account,
          ownerMigration: Ref.get(ownerMigration),
          wakeWebhookSources,
          uiPages: ui.pages,
          uiIcon: ui.dashboardIcon,
        },
      );
      const web = options.web ?? (yield* webFiles);
      const desktopReturns = yield* makeDesktopReturns(config);
      const publicSkills = yield* readExecutorSkills;
      const authoring = yield* localAppManagement(
        config,
        auth,
        managed.app,
        { executor: api },
        publicSkills,
      );
      const productRoutes = Layer.mergeAll(
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
        HttpRouter.add("GET", mcpWhoamiPath, mcp.whoami),
        HttpRouter.add("*", "/api/auth/*", oauth.handler),
        HttpRouter.add(
          "GET",
          executorServerIdentityPath,
          localRequest(config.port, config.browserOrigin).pipe(
            Effect.map((request) =>
              serverIdentityResponse(
                serverId,
                sameOrigins(
                  config.browserOrigin !== undefined &&
                    requestOrigin(config, request) === config.browserOrigin
                    ? config.browserOrigin
                    : `http://${request.headers.host}`,
                ),
                "no-store",
              ),
            ),
            Effect.catchTag("AuthForbidden", () =>
              Effect.succeed(
                HttpServerResponse.empty({ status: 403, headers: { "cache-control": "no-store" } }),
              ),
            ),
          ),
        ),
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
        HttpRouter.add("GET", "/account-connect/:connection", web.document),
        HttpRouter.add("GET", "/accounts", web.document),
        HttpRouter.add("GET", "/accounts/:account", web.document),
        HttpRouter.add("GET", "/accounts/:account/disconnect", web.document),
        HttpRouter.add("GET", "/webhooks/:app/:subscription", web.document),
        HttpRouter.add("GET", OAuthCallbackPath, desktopReturns.callback(web.document)),
        HttpRouter.add("GET", "/favicon.png", web.favicon),
        HttpRouter.add("GET", "/assets/:name", web.asset),
        HttpRouter.add("GET", "*", web.fallback),
      ).pipe(Layer.provide(requestRejections));
      const appHandler = yield* HttpRouter.toHttpEffect(appRoutes).pipe(
        Effect.provideService(Layer.CurrentMemoMap, yield* Layer.makeMemoMap),
      );
      const productHandler = yield* HttpRouter.toHttpEffect(productRoutes).pipe(
        Effect.provideService(Layer.CurrentMemoMap, yield* Layer.makeMemoMap),
      );
      return HttpRouter.add(
        "*",
        "*",
        withHostPipeline(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            return yield* appFromHost(request.headers.host, config.port) === undefined
              ? productHandler
              : appHandler.pipe(requestTiming);
          }).pipe(recordRequestRejections, Effect.provideService(CurrentActor, localActor)),
        ),
      );
    }),
  );
