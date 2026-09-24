import { createConnection } from "node:net";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Context, Data, Effect, Layer, Predicate, Schedule, Scope as EffectScope } from "effect";
import {
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

export {
  makeTestConfig,
  makeTestExecutor,
  makeTestWorkspaceHarness,
  makeTestWorkspaceLayer,
  memoryCredentialsPlugin,
  TestWorkspace,
  type TestConfigOptions,
  type TestDatabaseBackend,
  type TestFumaDb,
  type TestWorkspaceHarness,
} from "./test-config";
export {
  OAuthTestServer,
  serveOAuthTestServer,
  scopesFromAuthorizeUrl,
  OAuthTestServerAddressError,
  OAuthTestServerFlowError,
  type OAuthAuthorizationCompletion,
  type OAuthTokenSet,
  type OAuthTestServerOptions,
  type OAuthTestServerRequest,
  type OAuthTestServerShape,
} from "./testing/oauth-test-server";
export { createSqliteTestFumaDb, type SqliteTestFumaDb } from "./sqlite-test-db";
export {
  typeCheckOutputTypeScript,
  type OutputTypeScriptContract,
  type TypeCheckOutputTypeScriptOptions,
} from "./testing/tool-output-contract";

export class TestHttpServerAddressError extends Data.TaggedError("TestHttpServerAddressError")<{
  readonly address: unknown;
}> {}

export class TestHttpServerServeError extends Data.TaggedError("TestHttpServerServeError")<{
  readonly cause: unknown;
}> {}

export interface TestHttpServerShape {
  readonly baseUrl: string;
  readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient>;
  readonly url: (path?: string) => string;
}

export type TestHttpRoute = HttpRouter.Route<any, any>;
export type TestHttpRequest = HttpServerRequest.HttpServerRequest;
export type TestHttpResponse = HttpServerResponse.HttpServerResponse;

export const testHttpRoute = HttpRouter.route;

export const serveTestHttpRoutes = (
  routes: readonly TestHttpRoute[],
): Effect.Effect<
  TestHttpServerShape,
  TestHttpServerAddressError | TestHttpServerServeError,
  EffectScope.Scope
> =>
  makeTestHttpServer(
    HttpRouter.serve(HttpRouter.addAll(routes), {
      disableListenLog: true,
      disableLogger: true,
    }),
  );

export const serveTestHttpApp = (
  handler: (request: TestHttpRequest) => Effect.Effect<TestHttpResponse>,
): Effect.Effect<
  TestHttpServerShape,
  TestHttpServerAddressError | TestHttpServerServeError,
  EffectScope.Scope
> =>
  makeTestHttpServer(
    HttpServer.serve(HttpServerRequest.HttpServerRequest.asEffect().pipe(Effect.flatMap(handler))),
  );

export const serveTestHttpServerLayer = (
  serverLayer: Layer.Layer<never, any, any>,
): Effect.Effect<
  TestHttpServerShape,
  TestHttpServerAddressError | TestHttpServerServeError,
  EffectScope.Scope
> => makeTestHttpServer(serverLayer);

const makeTestHttpServer = (
  serverLayer: Layer.Layer<never, any, any>,
): Effect.Effect<
  TestHttpServerShape,
  TestHttpServerAddressError | TestHttpServerServeError,
  EffectScope.Scope
> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Layer.fresh(serverLayer.pipe(Layer.provideMerge(NodeHttpServer.layerTest))),
    ).pipe(Effect.mapError((cause) => new TestHttpServerServeError({ cause })));
    const server = Context.get(context, HttpServer.HttpServer);
    const address = server.address;
    if (!Predicate.isTagged(address, "TcpAddress")) {
      return yield* new TestHttpServerAddressError({ address });
    }
    const client = Context.get(context, HttpClient.HttpClient);
    // Under a loaded machine the listen callback can fire before the socket
    // reliably accepts; probe at the TCP level (no HTTP request, so handlers
    // that record requests never see it) until a connect succeeds.
    yield* Effect.callback<void, TestHttpServerServeError>((resume) => {
      const socket = createConnection({ host: "127.0.0.1", port: address.port }, () => {
        socket.end();
        resume(Effect.void);
      });
      socket.on("error", (cause) => resume(Effect.fail(new TestHttpServerServeError({ cause }))));
    }).pipe(Effect.retry(Schedule.both(Schedule.spaced("10 millis"), Schedule.recurs(100))));
    const baseUrl = `http://127.0.0.1:${address.port}`;
    return {
      baseUrl,
      httpClientLayer: Layer.succeed(HttpClient.HttpClient, client),
      url: (path = "") => new URL(path, baseUrl).toString(),
    };
  });
