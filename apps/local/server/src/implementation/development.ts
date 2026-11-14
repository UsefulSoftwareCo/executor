/** Scoped Vite adapter shared by browser and desktop development hosts. */
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

/** Vite's HMR socket path, served on the dashboard's own origin. */
const hmrPath = "/@vite/hmr";

/** Vite answers only its own subprotocols; any other upgrade would wait on it forever. */
const isHmrUpgrade = (incoming: IncomingMessage) =>
  incoming.headers.upgrade?.toLowerCase() === "websocket" &&
  ["vite-hmr", "vite-ping"].includes(incoming.headers["sec-websocket-protocol"] ?? "") &&
  new URL(incoming.url ?? "/", "http://localhost").pathname === hmrPath;

/** Options for one development host. Separate hosts keep separate Vite dependency caches. */
export type DevelopmentWebOptions = {
  /** Vite cache directory relative to the repository root; Vite's default when omitted. */
  readonly cacheDir?: string;
};

/** Serve UI assets and HMR beside the authenticated local API; closes Vite with the host. */
export const developmentWeb = (settings: ServerConfig, options: DevelopmentWebOptions = {}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(new URL("../../../web/", import.meta.url));
    // Vite's HMR socket server, fed the upgrades the asset handler takes for `hmrPath`. It never
    // listens: the browser reaches HMR at its page's own origin, through any proxy in front of
    // this server, and Vite stays clear of the Effect HTTP server's own upgrade handler.
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
              // T3 Code warms the entry graph before the first Electron request.
              warmup: { clientFiles: ["./src/client.tsx"] },
              allowedHosts:
                settings.browserOrigin === undefined
                  ? []
                  : [new URL(settings.browserOrigin).hostname],
              // With a server and no port or protocol, the client connects to its page's origin.
              ws: { server: hmrServer, path: hmrPath },
            },
          }),
        catch: () => new StartupFailed({ stage: "dev-server" }),
      }),
      (server) => Effect.promise(() => server.close()),
    );
    // The socket belongs to Vite once the upgrade is handed over. The handler waits for it to
    // close, and Effect then writes nothing to a destroyed socket. A WebSocket client sends nothing
    // before the handshake answer, so the upgrade has no buffered head to pass on.
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
      // Effect 4.1 may hand over an HTTP/2 request; this development server only speaks HTTP/1.
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
    // The same document handler the built server uses, reloaded by Vite when its modules change.
    // The local session cookie is strict; see `withSameSiteReload`.
    const document = withSameSiteReload(
      dashboardDocument({
        server: Effect.tryPromise({
          try: () =>
            ssr.runner.import<{ default: DashboardServer<LocalDocumentContext> }>(
              path.join(root, "src/server.ts"),
            ),
          catch: () => new StartupFailed({ stage: "dev-server" }),
        }).pipe(Effect.map((module) => module.default)),
        // Local pages read their session through the same in-process API as their data.
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
