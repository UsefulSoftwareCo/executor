/** Vite's middleware is a fallback handler; the Effect server owns route selection and TLS. */
import type { Server } from "node:http";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { Effect, FileSystem, Path } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { createServer } from "vite-plus";
import { DevelopmentWebFailed } from "../contracts/development.ts";

/**
 * Return native dashboard HTML and the Vite fallback; only the dedicated listener receives HMR upgrades.
 * `hmrOrigin` is the scheme and hostname the browser uses to reach that listener.
 */
export const developmentDashboard = (root: string, server: Server, hmrOrigin: URL) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const address = server.address();
    if (address === null || typeof address === "string")
      return yield* new DevelopmentWebFailed({ stage: "vite" });
    const vite = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          createServer({
            root,
            server: {
              middlewareMode: true,
              ws: {
                server,
                host: hmrOrigin.hostname,
                clientPort: address.port,
                protocol: hmrOrigin.protocol === "https:" ? "wss" : "ws",
              },
            },
          }),
        catch: () => new DevelopmentWebFailed({ stage: "vite" }),
      }),
      (vite) => Effect.promise(() => vite.close()),
    );
    // Return an Effect response so the root can set private cache headers before
    // the Node server writes them. Vite's fallback writes its response directly.
    const document = Effect.gen(function* () {
      const source = yield* fs.readFileString(path.join(root, "index.html"));
      const html = yield* Effect.tryPromise({
        try: () => vite.transformIndexHtml("/", source),
        catch: () => new DevelopmentWebFailed({ stage: "vite" }),
      });
      return HttpServerResponse.html(html);
    });
    const handler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const incoming = NodeHttpServerRequest.toIncomingMessage(request);
      const outgoing = NodeHttpServerRequest.toServerResponse(request);
      return yield* Effect.callback<HttpServerResponse.HttpServerResponse>((resume) => {
        const cleanup = () => {
          outgoing.off("finish", done);
          outgoing.off("close", done);
        };
        const done = () => {
          cleanup();
          resume(Effect.succeed(HttpServerResponse.empty({ status: outgoing.statusCode })));
        };
        outgoing.once("finish", done);
        outgoing.once("close", done);
        vite.middlewares(incoming, outgoing, (error?: unknown) => {
          cleanup();
          resume(
            Effect.succeed(
              HttpServerResponse.text(
                error === undefined ? "Not found" : "Development UI unavailable",
                { status: error === undefined ? 404 : 500 },
              ),
            ),
          );
        });
        return Effect.sync(cleanup);
      });
    });
    return { document, handler };
  });
