/** Node-backed development rendering shared by hosted dashboards. */
import type { Server } from "node:http";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { DevelopmentDashboardFailed } from "../contracts/development.ts";
import type { DocumentApi } from "../contracts/document.ts";
import { dashboardDocument, type DashboardServer } from "./document.ts";
import { HostPipeline } from "./in-process.ts";
import { Effect, Path } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer, isRunnableDevEnvironment } from "vite-plus";

export { DevelopmentDashboardFailed };

export const developmentDashboard = (
  root: string,
  server: Server,
  hmrOrigin: URL,
  apiOrigin: string,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const address = server.address();
    if (address === null || typeof address === "string")
      return yield* new DevelopmentDashboardFailed({ stage: "vite" });
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
        catch: () => new DevelopmentDashboardFailed({ stage: "vite" }),
      }),
      (vite) => Effect.promise(() => vite.close()),
    );
    const ssr = vite.environments.ssr;
    if (ssr === undefined || !isRunnableDevEnvironment(ssr))
      return yield* new DevelopmentDashboardFailed({ stage: "vite" });
    const document = <Context, E, R>(context: (api: DocumentApi) => Effect.Effect<Context, E, R>) =>
      dashboardDocument({
        server: Effect.tryPromise({
          try: () =>
            ssr.runner.import<{ default: DashboardServer<Context & DocumentApi> }>(
              path.join(root, "src/server.ts"),
            ),
          catch: () => new DevelopmentDashboardFailed({ stage: "vite" }),
        }).pipe(Effect.map((module) => module.default)),
        context,
      }).pipe(
        Effect.provideService(HostPipeline, (request) => {
          const url = new URL(request.url);
          return fetch(new URL(url.pathname + url.search, apiOrigin), request);
        }),
      );
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
