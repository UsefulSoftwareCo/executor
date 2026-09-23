/** Scoped Vite adapter shared by browser and desktop development hosts. */
import type { Server } from "node:http";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { Effect, Path } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { createServer } from "vite";
import type { ServerConfig } from "../contracts/config.ts";
import { StartupFailed } from "../contracts/startup.ts";
import type { LocalWeb } from "../node.ts";

/** Serve UI assets and HMR beside the authenticated local API; closes Vite with the host. */
export const developmentWeb = (settings: ServerConfig, hmrServer?: Server) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(new URL("../../../web/", import.meta.url));
    const address = hmrServer?.address();
    if (
      hmrServer !== undefined &&
      (address === null || address === undefined || typeof address === "string")
    ) {
      return yield* new StartupFailed({ stage: "dev-server" });
    }
    const socketPort = typeof address === "object" && address !== null ? address.port : 24678;
    const vite = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          createServer({
            root,
            logLevel: "error",
            appType: "mpa",
            ...(hmrServer === undefined
              ? {}
              : { cacheDir: path.join(root, "../../../.local/vite-desktop") }),
            server: {
              middlewareMode: true,
              // T3 Code warms the entry graph before the first Electron request.
              warmup: { clientFiles: ["./src/main.tsx"] },
              allowedHosts:
                settings.browserOrigin === undefined
                  ? []
                  : [new URL(settings.browserOrigin).hostname],
              // Keep Vite upgrades separate from the Effect HTTP server upgrade handler.
              ws: {
                host: "127.0.0.1",
                port: socketPort,
                clientPort: socketPort,
                protocol: "ws",
                ...(hmrServer === undefined ? {} : { server: hmrServer }),
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
