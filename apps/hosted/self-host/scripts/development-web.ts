import { createServer, request as createApiRequest } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { developmentDashboard } from "@executor-js/dashboard-start/development";
import { singleResourceOrigin } from "@executor-js/mcp-auth/grants";
import { Config, Console, Effect, Layer, Path } from "effect";
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { selfHostDocumentContext } from "../src/implementation/web.ts";

const isApiPath = (pathname: string) =>
  pathname === "/api" ||
  pathname.startsWith("/api/") ||
  pathname === "/health" ||
  pathname === "/openapi.json" ||
  pathname === "/mcp" ||
  /^\/org\/[^/]+\/mcp$/.test(pathname) ||
  pathname === "/.well-known" ||
  pathname.startsWith("/.well-known/");

const apiProxy = (apiOrigin: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const incoming = NodeHttpServerRequest.toIncomingMessage(request);
    const outgoing = NodeHttpServerRequest.toServerResponse(request);
    return yield* Effect.callback<HttpServerResponse.HttpServerResponse>((resume) => {
      let finished = false;
      let upstream: ReturnType<typeof createApiRequest> | undefined;
      const cleanup = () => {
        incoming.off("aborted", onAborted);
        outgoing.off("finish", finish);
        outgoing.off("close", onClose);
        upstream?.off("error", onError);
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        cleanup();
        resume(Effect.succeed(HttpServerResponse.empty({ status: outgoing.statusCode })));
      };
      const onAborted = () => upstream?.destroy();
      const onClose = () => {
        if (!finished) upstream?.destroy();
        finish();
      };
      const onError = () => {
        if (finished) return;
        if (incoming.aborted || outgoing.destroyed) return finish();
        if (outgoing.headersSent) {
          outgoing.destroy();
          return;
        }
        outgoing.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        outgoing.end("Hosted API unavailable");
      };
      const requestUrl = new URL(incoming.url ?? request.url, "http://localhost");
      const target = new URL(requestUrl.pathname + requestUrl.search, apiOrigin);
      upstream = createApiRequest(
        target,
        { method: incoming.method, headers: incoming.headers },
        (response) => {
          response.on("error", () => outgoing.destroy());
          outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, response.headers);
          response.pipe(outgoing);
        },
      );
      incoming.once("aborted", onAborted);
      outgoing.once("finish", finish);
      outgoing.once("close", onClose);
      upstream.once("error", onError);
      incoming.pipe(upstream);
      return Effect.sync(() => {
        cleanup();
        if (!finished) upstream?.destroy();
      });
    });
  });

const main = Effect.scoped(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const port = yield* Config.Number("PORT");
    const apiOrigin = yield* Config.String("HOSTED_API_URL");
    // The development origin serves the dashboard and the MCP and API resources alike.
    const origin = yield* Config.String("BETTER_AUTH_URL");
    const root = path.resolve(
      path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))),
      "../web",
    );
    const socket = yield* Effect.sync(() => createServer());
    const hmrSocket = yield* Effect.sync(() => createServer());
    yield* Layer.build(NodeHttpServer.layerServer(() => hmrSocket, { host: "127.0.0.1", port: 0 }));
    const dashboard = yield* developmentDashboard(
      root,
      hmrSocket,
      new URL("http://127.0.0.1"),
      apiOrigin,
    );
    const routes = HttpRouter.add(
      "*",
      "*",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const pathname = new URL(request.url, "http://localhost").pathname;
        if (isApiPath(pathname)) return yield* apiProxy(apiOrigin);
        const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
        if (pathname.startsWith("/@") || lastSegment.includes(".")) return yield* dashboard.handler;
        if (request.method === "GET")
          return yield* dashboard.document(selfHostDocumentContext(singleResourceOrigin(origin)));
        return yield* dashboard.handler;
      }),
    ).pipe(HttpRouter.provideRequest(FetchHttpClient.layer));
    yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true }).pipe(
        Layer.provide(NodeHttpServer.layer(() => socket, { host: "127.0.0.1", port })),
      ),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        socket.closeAllConnections();
        hmrSocket.closeAllConnections();
      }),
    );
    yield* Console.log(`Executor self-host development web listening on 127.0.0.1:${port}`);
    return yield* Effect.never;
  }),
).pipe(Effect.provide(NodeServices.layer));

if (import.meta.main) NodeRuntime.runMain(main);
