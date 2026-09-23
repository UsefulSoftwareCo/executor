import { ScheduleHostReady } from "@executor-js/sdk/scheduling";
/** Node composition edge shared by the CLI and a future desktop child process. */
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeStream from "@effect/platform-node/NodeStream";
import { localTelemetry } from "@executor-js/telemetry/local";
import { Deferred, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { DesktopBootstrap } from "./contracts/auth.ts";
import type { LocalServerOptions } from "./contracts/server.ts";
export type {
  LocalHttpMiddleware,
  LocalOAuthCallback,
  LocalServerOptions,
  LocalWeb,
} from "./contracts/server.ts";
import type { ServerConfig } from "./contracts/config.ts";
import { StartupFailed } from "./contracts/startup.ts";
import { makeLocalAuth, pairingUrl } from "./implementation/auth.ts";
import { openLocalAuthDatabase } from "./implementation/auth-database.ts";
import { openStorage } from "./implementation/storage.ts";
import { localApi } from "./implementation/server.ts";
import { startupPhase } from "./implementation/startup-diagnostics.ts";

/** Consume the parent's private fd3 envelope, bounded in size and time, and parse before use. */
export const readDesktopBootstrap = NodeStream.toString(
  () => createReadStream("", { fd: 3, autoClose: true }),
  { maxBytes: 4096, onError: () => new StartupFailed({ stage: "desktop-bootstrap" }) },
).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(DesktopBootstrap))),
  Effect.timeoutOrElse({
    duration: 5_000,
    orElse: () => Effect.fail(new StartupFailed({ stage: "desktop-bootstrap" })),
  }),
  Effect.mapError(() => new StartupFailed({ stage: "desktop-bootstrap" })),
);

/** Start one scoped loopback server. Its actual port and auth store belong to this lifetime. */
export const startLocalServer = (
  settings: ServerConfig,
  bootstrap?: DesktopBootstrap,
  options: LocalServerOptions = {},
) =>
  Effect.gen(function* () {
    const telemetry = yield* Layer.build(
      localTelemetry(settings.directory, "executor-local").pipe(Layer.provide(NodeServices.layer)),
    );
    return yield* Effect.gen(function* () {
      yield* Effect.logInfo("Starting local server");
      yield* Effect.addFinalizer(() => Effect.logInfo("Local server stopped"));
      const storage = yield* openStorage(settings.directory);
      const authDatabase = yield* openLocalAuthDatabase(settings.directory, storage).pipe(
        startupPhase("authentication"),
      );
      const auth = yield* makeLocalAuth(
        globalThis.crypto,
        settings.directory,
        authDatabase.sql,
      ).pipe(startupPhase("authentication"));
      if (bootstrap !== undefined) yield* auth.issue(bootstrap.token);
      const socket = yield* Effect.sync(() => createServer());
      const ready = yield* Deferred.make<void>();
      let port = settings.port;
      const routes = Layer.unwrap(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer;
          if (server.address._tag !== "InetAddressV4")
            return yield* new StartupFailed({ stage: "listen" });
          port = server.address.port;
          return localApi(
            { ...settings, port },
            globalThis.crypto,
            auth,
            options,
            authDatabase,
            storage,
          );
        }),
      );
      // Close active connections before the adapter's final shutdown. Requests receive
      // cancellation through Effect; an idle MCP stream cannot hold the process open.
      const listener = Layer.unwrap(
        Layer.build(
          NodeHttpServer.layer(() => socket, {
            host: "127.0.0.1",
            port: settings.port,
            gracefulShutdownTimeout: 1_000,
          }),
        ).pipe(startupPhase("listen"), Effect.map(Layer.succeedContext)),
      );
      yield* Layer.build(
        HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
          Layer.provide(listener),
          Layer.provide(Layer.succeed(ScheduleHostReady, Deferred.await(ready))),
          Layer.provide(NodeServices.layer),
          Layer.provide(Layer.succeedContext(telemetry)),
        ),
      ).pipe(startupPhase("composition"));
      yield* Deferred.succeed(ready, undefined);
      yield* Effect.addFinalizer(() => Effect.sync(() => socket.closeAllConnections()));
      const url = `http://127.0.0.1:${port}`;
      yield* Effect.logInfo("Local server ready").pipe(
        Effect.annotateLogs({ url, diagnostics: `${settings.directory}/diagnostics` }),
      );
      return {
        url,
        issuePairingLink: auth.issue().pipe(
          Effect.map(({ token, expiresAt }) => ({
            url: pairingUrl(settings.browserOrigin ?? url, token),
            expiresAt,
          })),
        ),
      };
    }).pipe(
      startupPhase("composition"),
      Effect.tapError((error) =>
        Effect.logError("Local server startup failed").pipe(
          Effect.annotateLogs({
            "startup.stage": error.stage,
            "error.type": "StartupFailed",
            ...(error.code === undefined ? {} : { "error.code": error.code }),
          }),
        ),
      ),
      Effect.provideContext(telemetry),
    );
  });
