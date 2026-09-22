import { executorSelfHostApiDocument } from "./contracts/api.ts";
import {
  startScheduleWorker,
  defaultScheduleWorkerOptions,
  ScheduleHostReady,
} from "@executor-js/sdk/scheduling";
import { gitRoutes } from "@executor-js/app-management";
import { hostedAppGitAccess } from "@executor-js/hosted-server/app-management";
/** Docker/Node composition edge. Runtime imports resolve only here. */
import { readExecutorSkills } from "@executor-js/app-templates/executor";
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import {
  browserTelemetry,
  requestServices,
  HostedExecutor,
  ScheduledAuthority,
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
import { localTelemetry } from "@executor-js/telemetry/local";
import { requestTiming } from "@executor-js/telemetry/http";
import { appAddresses, hostedAppUi } from "@executor-js/hosted-server/app-ui";
import { AppSignInApi, appSignInPage, appSignInScript } from "apps/ui/auth";
import { AppUiApi } from "apps/ui/contracts";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { dataDirectory, appUiBaseUrl } from "./contracts/config.ts";
import { safeHttpClient } from "@executor-js/utils/safe-fetch";
import { urlPolicyConfig, type HostEgress } from "@executor-js/utils/url-policy";
import { Config, Deferred, Effect, Layer, Option, Path, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { dashboardFiles } from "./implementation/web.ts";
import { selfHostApi } from "./implementation/api.ts";
import { selfHostMcp } from "./mcp.ts";
import { selfHostAuth } from "./auth.ts";
import { selfHostExecutor } from "./executor.ts";
import { selfHostDatabase } from "./database.ts";

const settings = Config.all({
  host: Config.String("HOST").pipe(Config.withDefault("0.0.0.0")),
  port: Config.Number("PORT").pipe(Config.withDefault(4400)),
}).pipe(
  Effect.flatMap(
    Schema.decodeUnknownEffect(
      Schema.Struct({
        host: Schema.NonEmptyString,
        port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
      }),
    ),
  ),
);

/** Compose the self-host route map without opening a listener; shared by the process entry and HTTP tests. */
export const selfHostRoutes = Effect.gen(function* () {
  const skills = yield* readExecutorSkills;
  const auth = yield* selfHostAuth;
  // Node can hook connect, so one client re-checks the addresses every host-side fetch resolves.
  const policy = yield* urlPolicyConfig;
  const egress: HostEgress = { policy, client: yield* safeHttpClient(policy) };
  const executorServices = Layer.succeedContext(
    yield* Layer.build(selfHostExecutor(skills, egress)),
  );
  yield* Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const authorize = yield* ScheduledAuthority;
    yield* startScheduleWorker(executor, authorize, {
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
  const path = yield* Path.Path;
  const configuredDirectory = yield* Config.String("DASHBOARD_DIR").pipe(Config.option);
  const directory = Option.isSome(configuredDirectory)
    ? path.resolve(configuredDirectory.value)
    : yield* path.fromFileUrl(new URL("../web/dist/", import.meta.url));
  const dashboard = yield* dashboardFiles(directory);
  const document = executorSelfHostApiDocument(auth.origin);
  const api = selfHostApi(document).pipe(
    Layer.provide(appUi.dashboard),
    HttpRouter.provideRequest(auth.appSessions),
    HttpRouter.provideRequest(catalogLive(skills, document, egress)),
    Layer.provide(requireUserLive),
    Layer.provide(requireOrganizationLive),
    HttpRouter.provideRequest(executorServices),
    Layer.provide(auth.identity),
    Layer.provide(auth.apiIdentity),
  );
  const mcpRoutes = Layer.mergeAll(
    HttpRouter.add("*", "/mcp", mcp.http),
    HttpRouter.add("GET", "/.well-known/oauth-protected-resource", mcpProtectedResource),
    HttpRouter.add("GET", "/.well-known/oauth-protected-resource/mcp", mcpProtectedResource),
    HttpRouter.add("GET", "/.well-known/oauth-authorization-server", mcpAuthorizationServer),
    HttpRouter.add(
      "GET",
      "/.well-known/oauth-authorization-server/api/auth",
      mcpAuthorizationServer,
    ),
  ).pipe(HttpRouter.provideRequest(executorServices), HttpRouter.provideRequest(auth.mcpIdentity));
  const authoring = gitRoutes.pipe(
    HttpRouter.provideRequest(hostedAppGitAccess),
    HttpRouter.provideRequest(executorServices),
    Layer.provide(auth.identity),
    Layer.provide(auth.apiIdentity),
  );
  const productRoutes = Layer.mergeAll(
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
    }),
  );
  return routes;
});

const server = Layer.unwrap(
  Effect.gen(function* () {
    const { host, port } = yield* settings;
    const ready = yield* Deferred.make<void>();
    const routes = yield* selfHostRoutes.pipe(
      Effect.provideService(ScheduleHostReady, Deferred.await(ready)),
    );
    return HttpRouter.serve(routes, { disableLogger: true }).pipe(
      Layer.tap(() => Deferred.succeed(ready, undefined)),
      Layer.provide(
        NodeHttpServer.layer(createServer, { host, port, gracefulShutdownTimeout: 5_000 }),
      ),
    );
  }),
).pipe(
  Layer.provide(selfHostDatabase),
  Layer.provide(
    Layer.unwrap(
      dataDirectory.pipe(Effect.map((directory) => localTelemetry(directory, "executor-selfhost"))),
    ),
  ),
  Layer.provide(NodeHttpServer.layerHttpServices),
);

if (import.meta.main) NodeRuntime.runMain(Layer.launch(server));
