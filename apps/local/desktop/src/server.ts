/** Desktop backend composition edge. The Electron parent owns this process and both private pipes. */
import { createServer } from "node:http";
import { createWriteStream } from "node:fs";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, Redacted, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  localConfiguration,
  LocalConfigurationError,
} from "../../server/src/implementation/bootstrap.ts";
import {
  readDesktopBootstrap,
  startLocalServer,
  type LocalOAuthCallback,
} from "../../server/src/node.ts";
import { DesktopCallback, DesktopFailed } from "./contracts/desktop.ts";

const server = Effect.gen(function* () {
  const settings = yield* localConfiguration(process.platform);
  const bootstrap = yield* readDesktopBootstrap;
  const callbackPipe = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const pipe = createWriteStream("", { fd: 4, autoClose: true });
      // Write callbacks surface pipe failures through the request Effect.
      pipe.on("error", () => {});
      return pipe;
    }),
    (pipe) => Effect.sync(() => pipe.destroy()),
  );
  const development =
    process.env.EXECUTOR_DESKTOP_DEV === "1"
      ? yield* Effect.gen(function* () {
          const hmrServer = yield* Effect.acquireRelease(
            Effect.sync(() => createServer()),
            (server) =>
              Effect.sync(() => {
                server.closeAllConnections();
                server.close();
              }),
          );
          yield* Effect.callback<void, DesktopFailed>((resume) => {
            const failed = () => resume(Effect.fail(new DesktopFailed({ stage: "start" })));
            hmrServer.once("error", failed);
            hmrServer.listen({ host: "127.0.0.1", port: 0 }, () => resume(Effect.void));
            return Effect.sync(() => hmrServer.removeListener("error", failed));
          });
          const { developmentWeb } = yield* Effect.promise(
            () => import("../../server/src/implementation/development.ts"),
          );
          return yield* developmentWeb(settings, hmrServer);
        })
      : undefined;
  const oauthCallback: LocalOAuthCallback = (origin) => (page) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      // The server has already matched OAuthCallbackPath. HEAD and the desktop return render the SPA.
      if (
        request.method === "GET" &&
        request.headers.host === new URL(origin).host &&
        request.headers["x-executor-desktop-return"] !== "1"
      ) {
        if (request.url.length > 8192) return HttpServerResponse.empty({ status: 400 });
        const callback = new URL(request.url, origin);
        if (callback.search === "") return yield* page;
        if (!callback.searchParams.has("state")) return HttpServerResponse.empty({ status: 400 });
        return yield* Schema.encodeEffect(Schema.fromJsonString(DesktopCallback))({
          version: 1,
          url: Redacted.make(callback.href),
        }).pipe(
          Effect.flatMap((message) =>
            Effect.tryPromise({
              try: () =>
                new Promise<void>((resolve, reject) =>
                  callbackPipe.write(`${message}\n`, (error) =>
                    error ? reject(error) : resolve(),
                  ),
                ),
              catch: () => new DesktopFailed({ stage: "oauth" }),
            }),
          ),
          Effect.as(
            HttpServerResponse.text(
              "<!doctype html><title>Executor</title><p>Return to Executor to finish connecting your account.</p>",
              {
                headers: {
                  "content-type": "text/html; charset=utf-8",
                  "cache-control": "no-store",
                  "referrer-policy": "no-referrer",
                  "content-security-policy": "default-src 'none'",
                },
              },
            ),
          ),
          Effect.catch(() =>
            Effect.succeed(
              HttpServerResponse.text(
                "Executor could not receive this sign-in. Return to the app and try again.",
                { status: 503 },
              ),
            ),
          ),
        );
      }
      return yield* page;
    });
  const local = yield* startLocalServer(settings, bootstrap, { web: development, oauthCallback });
  yield* Console.log(JSON.stringify({ version: 1, url: local.url }));
  yield* Effect.never;
});

NodeRuntime.runMain(
  Effect.scoped(server).pipe(
    Effect.provide(NodeServices.layer),
    Effect.catch((error) =>
      Console.error(
        Schema.is(LocalConfigurationError)(error)
          ? error.message
          : "Executor desktop server could not start. Check its configuration.",
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
    ),
  ),
);
