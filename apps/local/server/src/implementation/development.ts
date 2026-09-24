/** Scoped Vite adapter shared by browser and desktop development hosts. */
import { createServer as createHttpServer } from "node:http";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { Effect, Path } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { createServer } from "vite";
import type { ServerConfig } from "../contracts/config.ts";
import { StartupFailed } from "../contracts/startup.ts";
import type { LocalWeb } from "../node.ts";

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
    // HMR gets its own loopback listener on a free port, so concurrent checkouts never collide
    // and Vite upgrades stay separate from the Effect HTTP server upgrade handler.
    const hmrServer = yield* Effect.acquireRelease(
      Effect.sync(() => createHttpServer()),
      (server) =>
        Effect.sync(() => {
          server.closeAllConnections();
          server.close();
        }),
    );
    const socketPort = yield* Effect.callback<number, StartupFailed>((resume) => {
      const failed = () => resume(Effect.fail(new StartupFailed({ stage: "dev-server" })));
      hmrServer.once("error", failed);
      hmrServer.listen({ host: "127.0.0.1", port: 0 }, () => {
        const address = hmrServer.address();
        resume(
          address === null || typeof address === "string"
            ? Effect.fail(new StartupFailed({ stage: "dev-server" }))
            : Effect.succeed(address.port),
        );
      });
      return Effect.sync(() => hmrServer.removeListener("error", failed));
    });
    const vite = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          createServer({
            root,
            logLevel: "error",
            appType: "mpa",
            ...(options.cacheDir === undefined
              ? {}
              : { cacheDir: path.join(root, "../../..", options.cacheDir) }),
            server: {
              middlewareMode: true,
              // T3 Code warms the entry graph before the first Electron request.
              warmup: { clientFiles: ["./src/main.tsx"] },
              allowedHosts:
                settings.browserOrigin === undefined
                  ? []
                  : [new URL(settings.browserOrigin).hostname],
              ws: {
                host: "127.0.0.1",
                port: socketPort,
                clientPort: socketPort,
                protocol: "ws",
                server: hmrServer,
              },
            },
          }),
        catch: () => new StartupFailed({ stage: "dev-server" }),
      }),
      (server) => Effect.promise(() => server.close()),
    );
    const serve = (url?: string) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const incoming = NodeHttpServerRequest.toIncomingMessage(request);
        const response = NodeHttpServerRequest.toServerResponse(request);
        const originalUrl = incoming.url;
        if (url !== undefined) incoming.url = url;
        return yield* Effect.callback<HttpServerResponse.HttpServerResponse>((resume) => {
          const cleanup = () => {
            incoming.url = originalUrl;
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
    // Only a document route rewrites to index.html. Vite owns HTML transforms and bundled-dev output.
    const assets = serve();
    return {
      document: serve("/index.html"),
      favicon: assets,
      asset: assets,
      fallback: assets,
    } satisfies LocalWeb;
  });
