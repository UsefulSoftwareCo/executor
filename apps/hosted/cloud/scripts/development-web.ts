/** Serve the cloud dashboard directly so Alchemy owns the complete process lifetime. */
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { HttpRouter, HttpClient, HttpServerRequest, FetchHttpClient } from "effect/unstable/http";
import { CloudEntry } from "../src/contracts/entry.ts";
import { cloudEntryDocument } from "../src/implementation/entry.ts";
import { browserReturnTo } from "@executor-js/hosted-server/browser/contracts";
import { cloudDevelopment } from "../src/contracts/development.ts";
import { cloudSessionCookiePrefix } from "../src/contracts/browser.ts";
import { homepageResponse } from "../src/implementation/homepage-response.ts";
import { marketingFiles } from "../src/implementation/marketing.ts";
import { developmentDashboard } from "../src/implementation/development-web.ts";
import { cloudDevtools } from "@executor-js/hosted-testing/cloud";

/** Route map shared by the cloud development entry point and its HTTP checks. */
export const developmentRoutes = (
  marketing: Effect.Success<ReturnType<typeof marketingFiles>>,
  dashboard: Effect.Success<ReturnType<typeof developmentDashboard>>,
  cookiePrefix: string,
  apiOrigin: string,
) => {
  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/",
      homepageResponse(cookiePrefix, marketing.experiment, dashboard.document),
    ),
    ...(["login", "login/sso", "create"] as const).map((page) =>
      HttpRouter.add(
        "GET",
        `/${page}`,
        cloudEntryDocument(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const redirect = browserReturnTo(
              new URL(request.url, apiOrigin).searchParams.get("redirect"),
            );
            const client = yield* HttpClient.HttpClient;
            const response = yield* client.get(
              `${apiOrigin}/api/entry?page=${page}&redirect=${encodeURIComponent(redirect)}`,
              { headers: { cookie: request.headers.cookie ?? "" } },
            );
            if (response.status !== 200)
              return yield* Effect.fail(new Error("Entry lookup unavailable"));
            return yield* response.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(CloudEntry)),
            );
          }),
          dashboard.document,
        ),
      ),
    ),
    HttpRouter.add("GET", "/home", marketing.document),
    ...marketing.paths.map((path) => HttpRouter.add("GET", path, marketing.asset)),
    HttpRouter.add("*", "*", dashboard.handler),
  ).pipe(HttpRouter.provideRequest(FetchHttpClient.layer));
};

const main = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* Config.String("HOME");
    const root = path.resolve(
      path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))),
      "../web",
    );
    // Alchemy starts this process after the shared Site build has finished.
    const marketingRoot = path.resolve(root, "../../../marketing");
    const configuration = yield* cloudDevelopment;
    const origin = new URL(configuration.origin);
    // Behind the local proxy the origin's TLS ends at the proxy; this process serves plain HTTP.
    const proxied = Option.isSome(configuration.webPort);
    const tls =
      origin.protocol === "https:" && !proxied
        ? {
            cert: Buffer.from(yield* fs.readFile(path.join(home, ".portless/server.pem"))),
            key: Buffer.from(yield* fs.readFile(path.join(home, ".portless/server-key.pem"))),
          }
        : null;
    const listenHost = !proxied && origin.hostname === "[::1]" ? "::1" : "127.0.0.1";
    const socket = yield* Effect.sync(() =>
      tls === null ? createHttpServer() : createServer(tls),
    );
    // Effect owns HTTP upgrades on the product listener. Vite gets a separate scoped TLS listener for HMR.
    const hmrSocket = yield* Effect.sync(() =>
      tls === null ? createHttpServer() : createServer(tls),
    );
    yield* Layer.build(NodeHttpServer.layerServer(() => hmrSocket, { host: listenHost, port: 0 }));
    // The proxy routes whole hostnames, so a proxied HMR client connects to its loopback listener.
    const dashboard = yield* developmentDashboard(
      root,
      hmrSocket,
      proxied ? new URL(`http://${listenHost}`) : origin,
    );
    const marketing = yield* marketingFiles(path.join(marketingRoot, "dist"));
    const routes = Layer.mergeAll(
      yield* cloudDevtools,
      developmentRoutes(
        marketing,
        dashboard,
        cloudSessionCookiePrefix(origin.origin),
        `http://127.0.0.1:${configuration.apiPort}`,
      ),
    );
    yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true }).pipe(
        Layer.provide(
          NodeHttpServer.layer(() => socket, {
            host: listenHost,
            port: Option.getOrElse(configuration.webPort, () => Number(origin.port)),
            gracefulShutdownTimeout: 1_000,
          }),
        ),
      ),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => socket.closeAllConnections()));
    yield* Console.log(`Executor cloud dev: ${origin.origin}`);
    yield* Effect.never;
  }),
).pipe(Effect.provide(NodeServices.layer));

if (import.meta.main) NodeRuntime.runMain(main);
