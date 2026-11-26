import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  dashboardDocument,
  withSameSiteReload,
  type DashboardServer,
} from "@executor-js/dashboard-start/document";
import type { LocalDocumentContext } from "@executor-js/local-web/document";
import { Effect, Path } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer, isRunnableDevEnvironment } from "vite";
import type { ServerConfig } from "../contracts/config.ts";
import { StartupFailed } from "../contracts/startup.ts";
import type { LocalWeb } from "../node.ts";

const hmrPath = "/@vite/hmr";

const isHmrUpgrade = (incoming: IncomingMessage) =>
  incoming.headers.upgrade?.toLowerCase() === "websocket" &&
  ["vite-hmr", "vite-ping"].includes(incoming.headers["sec-websocket-protocol"] ?? "") &&
  new URL(incoming.url ?? "/", "http://localhost").pathname === hmrPath;

export type DevelopmentWebOptions = {
  readonly cacheDir?: string;
};

export const developmentWeb = (settings: ServerConfig, options: DevelopmentWebOptions = {}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(new URL("../../../web/", import.meta.url));
    const hmrServer = createHttpServer();
    const vite = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          createServer({
            root,
            logLevel: "error",
            appType: "custom",
            ...(options.cacheDir === undefined
              ? {}
              : { cacheDir: path.join(root, "../../..", options.cacheDir) }),
            server: {
              middlewareMode: true,
              warmup: { clientFiles: ["./src/client.tsx"] },
              allowedHosts:
                settings.browserOrigin === undefined
                  ? []
                  : [new URL(settings.browserOrigin).hostname],
              ws: { server: hmrServer, path: hmrPath },
            },
          }),
        catch: () => new StartupFailed({ stage: "dev-server" }),
      }),
      (server) => Effect.promise(() => server.close()),
    );
    const hmrUpgrade = (incoming: IncomingMessage) =>
      Effect.callback<HttpServerResponse.HttpServerResponse>((resume) => {
        const { socket } = incoming;
        const closed = () => resume(Effect.succeed(HttpServerResponse.empty()));
        socket.once("close", closed);
        hmrServer.emit("upgrade", incoming, socket, Buffer.alloc(0));
        return Effect.sync(() => socket.off("close", closed));
      });
    const assets = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const incoming = NodeHttpServerRequest.toIncomingMessage(request);
      const response = NodeHttpServerRequest.toServerResponse(request);
      if (!(incoming instanceof IncomingMessage) || !(response instanceof ServerResponse))
        return HttpServerResponse.empty({ status: 505 });
      if (isHmrUpgrade(incoming)) return yield* hmrUpgrade(incoming);
      return yield* Effect.callback<HttpServerResponse.HttpServerResponse>((resume) => {
        const cleanup = () => {
          response.off("finish", done);
          response.off("close", done);
        };
        const done = () => {
          cleanup();
          resume(Effect.succeed(HttpServerResponse.empty({ status: response.statusCode })));
        };
        response.once("finish", done);
        response.once("close", done);
        vite.middlewares(incoming, response, (error?: unknown) => {
          cleanup();
          if (error !== undefined) {
            response.statusCode = 500;
            response.end("The development UI could not be loaded.");
            resume(Effect.succeed(HttpServerResponse.empty({ status: response.statusCode })));
          } else {
            resume(Effect.succeed(HttpServerResponse.empty({ status: 404 })));
          }
        });
        return Effect.sync(cleanup);
      });
    });
    const ssr = vite.environments.ssr;
    if (ssr === undefined || !isRunnableDevEnvironment(ssr))
      return yield* new StartupFailed({ stage: "dev-server" });
    const document = withSameSiteReload(
      dashboardDocument({
        server: Effect.tryPromise({
          try: () =>
            ssr.runner.import<{ default: DashboardServer<LocalDocumentContext> }>(
              path.join(root, "src/server.ts"),
            ),
          catch: () => new StartupFailed({ stage: "dev-server" }),
        }).pipe(Effect.map((module) => module.default)),
        context: () => Effect.succeed({}),
        headers: { "referrer-policy": "no-referrer" },
      }),
    );
    return {
      document,
      favicon: assets,
      asset: assets,
      fallback: assets,
    } satisfies LocalWeb;
  });
