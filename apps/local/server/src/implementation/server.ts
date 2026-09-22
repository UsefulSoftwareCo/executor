import { localAppBrowserHandlers } from "./app-browser.ts";
import { startScheduleWorker, defaultScheduleWorkerOptions } from "@executor-js/sdk/scheduling";
import { localScheduleHandlers } from "./schedules.ts";
import { localMcpApproval } from "./mcp-approvals.ts";
import { makeLocalMcpOAuth } from "./mcp-oauth.ts";
import { remoteRegistry } from "@executor-js/app-registry";
import { localAppManagement } from "./app-management.ts";

/** Local host composition. The SDK owns operations; this package owns local resources and access. */
import {
  ExecutorApi,
  WorkflowHost,
  type Executor,
  AccountNotFound,
  AppNotFound,
  createExecutor,
  toEffectRuntime,
  executorHandlers,
  webhookCallback,
} from "@executor-js/sdk/core";
import { filesystemBlobStore, workerdApps } from "@executor-js/sdk/node";
import { Config, Effect, Layer, Path, Redacted, Result, Deferred, Schedule } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { requestTiming } from "@executor-js/telemetry/http";
import { safeHttpClient } from "@executor-js/utils/safe-fetch";
import type { HostEgress } from "@executor-js/utils/url-policy";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { LocalServerOptions } from "../contracts/server.ts";
import type { ServerConfig } from "../contracts/config.ts";
import { aesGcmCredentials as credentials } from "@executor-js/sdk/core";
import { openStorage } from "./storage.ts";
import { installExecutorApp } from "./executor-app.ts";
import { localMcp } from "./mcp.ts";
import { dashboard } from "./dashboard.ts";
import { makeLocalAuth, authHandlers, type LocalAuth } from "./auth.ts";
import { LocalWebhookSetupApi } from "../contracts/webhook-setup.ts";
import { localWebhookSetupHandlers } from "./webhook-setup.ts";
import { accountConnectHandlers } from "./account-connections.ts";
import { appUi } from "./app-ui.ts";
import { appAuthentication, appRequest } from "./app-auth.ts";
import { AppAuthenticationApi, appFromHost } from "../contracts/app-ui.ts";
import { AppUiApi } from "apps/ui/contracts";
import { AppSignInApi, appSignInPage, appSignInScript } from "apps/ui/auth";
import { DashboardApi, OAuthCallbackPath } from "../contracts/dashboard.ts";
import { LocalAuthApi } from "../contracts/auth.ts";
import { AccountConnectApi } from "../contracts/account-connections.ts";
import { browserTelemetry } from "./telemetry.ts";
import { webFiles } from "./web.ts";
import { localManagementDocument } from "../contracts/management.ts";
import { gitSourceStorage } from "@executor-js/app-source";
import { nativeRepositories } from "@executor-js/app-source/node";

/** Initialize local persistence and compose the API, without choosing a socket implementation. */
export const localApi = (
  config: ServerConfig,
  crypto: Crypto,
  existingAuth?: LocalAuth,
  options: LocalServerOptions = {},
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const auth = existingAuth ?? (yield* makeLocalAuth(crypto, config.directory));
      const path = yield* Path.Path;
      const directory = path.resolve(config.directory);
      const storage = yield* openStorage(directory);
      const credentialStore = yield* credentials(config.encryptionKey, crypto);
      // Node can hook connect, so every host-side fetch re-checks the addresses a name resolves
      // to. The agent lives for this layer's scope, which is the process.
      const httpClient = yield* safeHttpClient(config.urlPolicy);
      const egress: HostEgress = { policy: config.urlPolicy, client: httpClient };
      const blobs = filesystemBlobStore({ directory: path.join(directory, "builds") });
      const ready = yield* Deferred.make<Executor>();
      const { runtime, workflows } = yield* workerdApps({
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
      });
      const registry = remoteRegistry(
        yield* Config.String("EXECUTOR_REGISTRY_URL").pipe(
          Config.withDefault("https://v2.executor.sh"),
        ),
      );
      const repositories = nativeRepositories(path.join(directory, "repositories"));
      const sources = gitSourceStorage(repositories);
      const executor = yield* createExecutor({
        workflows,
        webhookOrigin:
          config.webhookOrigin ?? config.browserOrigin ?? `http://localhost:${config.port}`,
        storage,
        blobs,
        sources,
        credentials: credentialStore,
        runtime,
        oauth: {
          httpClient,
          clientName: "Executor Local",
          urlPolicy: config.urlPolicy,
          ...(config.oauthClientMetadataUrl === undefined
            ? {}
            : { clientMetadataUrl: config.oauthClientMetadataUrl }),
        },
      });
      yield* Deferred.succeed(ready, executor);
      yield* Effect.forkScoped(
        executor[WorkflowHost].reconcile.pipe(
          Effect.catch(() => Effect.logWarning("Workflow queue reconciliation failed")),
          Effect.repeat(Schedule.spaced("5 seconds")),
        ),
      );
      yield* startScheduleWorker(executor, () => Effect.void, {
        ...defaultScheduleWorkerOptions,
        runner: "local",
        concurrency: yield* Config.Number("EXECUTOR_SCHEDULE_CONCURRENCY").pipe(
          Config.withDefault(defaultScheduleWorkerOptions.concurrency),
        ),
      });
      const managed = yield* installExecutorApp(executor, storage, credentialStore, config);
      const access = HttpRouter.middleware((httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          // Browser reads use the separate dashboard API; these routes remain programmatic.
          if (request.headers.origin !== undefined)
            return HttpServerResponse.empty({ status: 403 });
          if (request.headers.authorization !== `Bearer ${Redacted.value(config.apiKey)}`) {
            return HttpServerResponse.empty({ status: 401 });
          }
          const pathname = yield* Effect.try(() =>
            decodeURIComponent(new URL(request.url, "http://localhost").pathname),
          ).pipe(Effect.result);
          if (Result.isFailure(pathname)) return HttpServerResponse.empty({ status: 400 });
          const target = pathname.success.replace(/\/$/, "");
          // SDK review primitives are only delivered through the product's browser session routes.
          if (/^\/v1\/scheduled-runs\/[^/]+\/approval$/.test(target))
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
      const oauth = yield* makeLocalMcpOAuth(config, auth, crypto);
      const mcp = yield* localMcp(executor, config.mcp, config, oauth);
      const programmatic = Layer.mergeAll(
        HttpRouter.add(
          "GET",
          "/openapi.json",
          HttpServerResponse.jsonUnsafe(localManagementDocument()),
        ),
        HttpApiBuilder.layer(ExecutorApi).pipe(
          Layer.provide(
            executorHandlers({
              ...executor,
              accountConnections: {
                ...executor.accountConnections,
                create: (input) => {
                  if (input.account === managed.account)
                    return Effect.fail(new AccountNotFound({ account: input.account }));
                  if (input.target?.app === managed.app)
                    return Effect.fail(new AppNotFound({ app: input.target.app }));
                  return executor.accountConnections.create(input);
                },
              },
            }),
          ),
        ),
      ).pipe(Layer.provide(access.layer));
      const ui = appUi(executor, storage, toEffectRuntime(runtime, blobs), config, auth);
      const signIn = yield* appAuthentication(executor, auth, config, crypto);
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
        HttpApiBuilder.layer(AppSignInApi).pipe(Layer.provide(signIn.app)),
        HttpApiBuilder.layer(AppUiApi).pipe(
          Layer.provide(ui.api),
          Layer.provide(ui.authenticated.layer),
        ),
        HttpRouter.add("POST", "/_executor/api/telemetry/traces", ui.telemetry("traces")),
        HttpRouter.add("POST", "/_executor/api/telemetry/logs", ui.telemetry("logs")),
        HttpRouter.add("GET", "/_executor/auth/callback", appSignInPage()),
        HttpRouter.add("GET", "/_executor/auth/browser.js", appSignInScript()),
        HttpRouter.add("GET", "/_executor/version", ui.versions),
        HttpRouter.add("GET", "/_executor/watch.js", ui.watch),
        HttpRouter.add("GET", "/_executor/assets/:deployment/*", ui.asset),
        // Keep the GET/HEAD SPA fallback out of host-owned namespaces. Unregistered methods already return 404.
        HttpRouter.add("GET", "/_executor/*", notFound),
        HttpRouter.add("GET", "/dashboard/*", notFound),
        HttpRouter.add("GET", "/auth/*", notFound),
        HttpRouter.add("GET", "/v1/*", notFound),
        HttpRouter.add("GET", "/mcp/*", notFound),
        HttpRouter.add("GET", "*", ui.page),
      ).pipe(Layer.provide(appOriginAccess.layer), Layer.provide(privateResponses.layer));
      const dashboardApi = dashboard(executor, storage, credentialStore, config, auth, egress, {
        managedApp: managed.app,
        managedAccount: managed.account,
      });
      const web = options.web ?? (yield* webFiles);
      // Dashboard-host routes never include the app-origin APIs.
      const authoring = yield* localAppManagement(config, auth, managed.app, {
        executor,
        sources,
        repositories,
        registry,
        blobs,
      });
      const productRoutes = Layer.mergeAll(
        HttpApiBuilder.layer(LocalWebhookSetupApi).pipe(
          Layer.provide(localWebhookSetupHandlers(executor, config, auth)),
        ),
        HttpRouter.add("*", "/api/webhooks/:appId/:subscriptionId", webhookCallback(executor)),
        authoring,
        options.devtools === undefined ? Layer.empty : options.devtools(auth, config),
        HttpRouter.add(
          "POST",
          "/dashboard/api/telemetry/traces",
          browserTelemetry(config, "traces"),
        ),
        HttpRouter.add("POST", "/dashboard/api/telemetry/logs", browserTelemetry(config, "logs")),
        HttpApiBuilder.layer(AppAuthenticationApi).pipe(
          Layer.provide(signIn.dashboard),
          Layer.provide(privateResponses.layer),
        ),
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
          localMcpApproval(mcp.approvals, auth, config, executor, oauth),
        ),
        HttpRouter.add(
          "POST",
          "/dashboard/api/mcp/approvals/:requestId",
          localMcpApproval(mcp.approvals, auth, config, executor, oauth),
        ),
        HttpApiBuilder.layer(AccountConnectApi).pipe(
          Layer.provide(accountConnectHandlers(executor, config, crypto, managed)),
          Layer.provide(privateResponses.layer),
        ),
        HttpApiBuilder.layer(DashboardApi).pipe(
          Layer.provide(dashboardApi.handlers),
          Layer.provide(localScheduleHandlers(executor, config, auth)),
          Layer.provide(localAppBrowserHandlers(executor)),
          Layer.provide(dashboardApi.access),
        ),
        HttpApiBuilder.layer(LocalAuthApi).pipe(
          Layer.provide(authHandlers(auth, config)),
          Layer.provide(privateResponses.layer),
        ),
        HttpRouter.add("GET", "/", web.document),
        HttpRouter.add("GET", "/apps", web.document),
        HttpRouter.add("GET", "/apps/add/custom", web.document),
        HttpRouter.add("GET", "/apps/:app", web.document),
        HttpRouter.add("GET", "/app-auth", web.document),
        HttpRouter.add("GET", "/apps/:app/setup", web.document),
        HttpRouter.add("GET", "/apps/:app/delete", web.document),
        HttpRouter.add("GET", "/accounts/add", web.document),
        HttpRouter.add("GET", "/connect", web.document),
        HttpRouter.add("GET", "/approvals", web.document),
        HttpRouter.add("GET", "/approvals/:run", web.document),
        HttpRouter.add("GET", "/account-connect/:connection", web.document),
        HttpRouter.add("GET", "/accounts", web.document),
        HttpRouter.add("GET", "/accounts/:account", web.document),
        HttpRouter.add("GET", "/accounts/:account/credentials", web.document),
        HttpRouter.add("GET", "/accounts/:account/disconnect", web.document),
        HttpRouter.add(
          "GET",
          OAuthCallbackPath,
          options.oauthCallback === undefined
            ? web.document
            : options.oauthCallback(`http://127.0.0.1:${config.port}`)(web.document),
        ),
        HttpRouter.add("GET", "/favicon.png", web.favicon),
        HttpRouter.add("GET", "/assets/:name", web.asset),
        HttpRouter.add("GET", "*", web.fallback),
      );
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
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          return yield* appFromHost(request.headers.host, config.port) === undefined
            ? productHandler
            : appHandler.pipe(requestTiming);
        }),
      );
    }),
  );
