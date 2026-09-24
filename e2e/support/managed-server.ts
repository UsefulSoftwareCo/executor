/** A complete product process, with private lifecycle control for persistence/restart scenarios. */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  Config,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import type { Target } from "./platform.ts";

class ServerFailed extends Schema.TaggedError<ServerFailed>()("ServerFailed", {
  message: Schema.String,
}) {}
/** The runner owns every process generation and keeps the same synthetic secrets across restarts. */
export const startManagedServer = (
  target: typeof Target.Service,
  mode: "product" | "development" = "product",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      processes = yield* ChildProcessSpawner.ChildProcessSpawner,
      path = yield* Path.Path,
      http = yield* HttpClient.HttpClient;
    const port = new URL(target.metadata.origin).port;
    let origin = target.metadata.origin;
    const runtimePath = yield* Config.String("EXECUTOR_E2E_RUNTIME_PATH").pipe(
      Config.withDefault(process.env.PATH ?? ""),
    );
    const packagedEntry = yield* Config.NonEmptyString("EXECUTOR_E2E_LOCAL_ENTRY").pipe(
      Config.option,
    );
    const entry =
      target.metadata.target === "local" && Option.isSome(packagedEntry)
        ? { command: [packagedEntry.value, "serve"], cwd: target.directory }
        : {
            command: [
              target.metadata.target === "local"
                ? "apps/local/server/src/bin.ts"
                : mode === "development"
                  ? "apps/hosted/testing/self-host.ts"
                  : "apps/hosted/self-host/src/main.ts",
              ...(target.metadata.target === "local" ? ["serve"] : []),
            ],
          };

    const gate = yield* Semaphore.make(1);
    let current: Scope.Closeable | undefined;
    const env = {
      PATH: runtimePath,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: port,
      EXECUTOR_PORT: port,
      EXECUTOR_API_KEY: Redacted.value(target.apiKey),
      EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      EXECUTOR_DATA_DIR: `${target.directory}/data`,
      BETTER_AUTH_URL: target.metadata.origin,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      // Exercise named loopback callbacks and explicit private HTTP transport in the real host.
      ...(target.metadata.target === "self-host"
        ? {
            EXECUTOR_OAUTH_CALLBACK_URL: `http://account-picker.localhost:${port}/api/oauth/callback?tenant=fixture`,
            EXECUTOR_URL_ALLOW_HTTP_ORIGINS: '["http://oauth.internal:8080"]',
          }
        : {}),
      EXECUTOR_ENVIRONMENT: "e2e",
      EXECUTOR_BUILD_VERSION: target.metadata.commit,
      EXECUTOR_WORKER_BUNDLE: path.resolve(".local/test-runtime/host.json"),
      EXECUTOR_TEST_CLOCK_OFFSET_MS: "0",
    };
    const stop = Effect.suspend(() =>
      current === undefined
        ? Effect.void
        : Scope.close(current, Exit.succeed(undefined)).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                current = undefined;
              }),
            ),
          ),
    );
    yield* Effect.addFinalizer(() => stop);
    const start = Effect.gen(function* () {
      if (current !== undefined) return;
      const scope = yield* Scope.make();
      current = scope;
      yield* Effect.gen(function* () {
        const child = yield* processes.spawn(
          ChildProcess.make(
            target.metadata.target === "local" ? "node" : "bun",
            [
              ...(target.metadata.target === "local"
                ? ["--import", new URL("./wall-clock.mjs", import.meta.url).href]
                : []),
              ...entry.command,
            ],
            {
              extendEnv: false,
              ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
              env,
              stdout: "pipe",
              stderr: "pipe",
              killSignal: "SIGTERM",
              forceKillAfter: "15 seconds",
            },
          ),
        );
        const ready = yield* Deferred.make<void>();
        const output = yield* Stream.merge(child.stdout, child.stderr).pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) =>
            Effect.gen(function* () {
              yield* fs.writeFileString(
                `${target.directory}/server.log`,
                `${line.replace(/#pair=[a-f0-9]{64}/g, "#pair=<redacted>")}\n`,
                { flag: "a", mode: 0o600 },
              );
              if (/^Executor: http:\/\/127\.0\.0\.1:\d+$/.test(line)) {
                origin = line.slice("Executor: ".length);
                env.PORT = new URL(origin).port;
                env.EXECUTOR_PORT = env.PORT;
                env.BETTER_AUTH_URL = origin;
                if (target.metadata.target === "self-host")
                  env.EXECUTOR_OAUTH_CALLBACK_URL = `http://account-picker.localhost:${env.PORT}/api/oauth/callback?tenant=fixture`;
                yield* Deferred.succeed(ready, undefined);
              }
            }),
          ),
          Effect.forkScoped,
        );
        const check =
          target.metadata.target === "local" || mode === "product"
            ? Deferred.await(ready)
            : Effect.scoped(
                http.get(`${target.metadata.origin}/health`).pipe(
                  Effect.flatMap((response) =>
                    Effect.gen(function* () {
                      if (response.status !== 200)
                        return yield* new ServerFailed({ message: "Not ready" });
                      yield* response.text;
                    }),
                  ),
                ),
              ).pipe(Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 240 }));
        yield* Effect.raceFirst(
          check,
          child.exitCode.pipe(
            Effect.flatMap((code) =>
              // Exit can arrive before the pipe's buffered lines reach disk. Keep
              // the startup diagnostic before failure closes the reader's scope.
              Fiber.join(output).pipe(
                Effect.timeoutOption("3 seconds"),
                Effect.andThen(
                  Effect.fail(
                    new ServerFailed({ message: `Server exited before readiness (${code})` }),
                  ),
                ),
              ),
            ),
          ),
        ).pipe(Effect.timeout("90 seconds"));
      }).pipe(
        Scope.provide(scope),
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Scope.close(scope, exit).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (current === scope) current = undefined;
                  }),
                ),
              )
            : Effect.void,
        ),
      );
    });
    const control = (action: "start" | "stop" | "restart") =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.headers.authorization !== `Bearer ${Redacted.value(target.apiKey)}`)
          return HttpServerResponse.empty({ status: 401 });
        yield* gate.withPermits(1)(
          Effect.gen(function* () {
            if (action !== "start") yield* stop;
            if (action !== "stop") yield* start;
          }),
        );
        return HttpServerResponse.jsonUnsafe({ ok: true });
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 500 }))));
    const routes = Layer.mergeAll(
      HttpRouter.add(
        "POST",
        "/clock/advance",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.headers.authorization !== `Bearer ${Redacted.value(target.apiKey)}`)
            return HttpServerResponse.empty({ status: 401 });
          const body = yield* request.json.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  milliseconds: Schema.Int.check(
                    Schema.isBetween({ minimum: 1, maximum: 86_400_000 }),
                  ),
                }),
              ),
            ),
          );
          return yield* gate.withPermits(1)(
            Effect.gen(function* () {
              if (target.metadata.target !== "local" || current !== undefined)
                return HttpServerResponse.empty({ status: 409 });
              const offset = Number(env.EXECUTOR_TEST_CLOCK_OFFSET_MS) + body.milliseconds;
              if (offset > 86_400_000) return HttpServerResponse.empty({ status: 400 });
              env.EXECUTOR_TEST_CLOCK_OFFSET_MS = String(offset);
              return HttpServerResponse.jsonUnsafe({ offset });
            }),
          );
        }),
      ),
      HttpRouter.add("POST", "/start", control("start")),
      HttpRouter.add("POST", "/stop", control("stop")),
      HttpRouter.add("POST", "/restart", control("restart")),
    );
    const services = yield* Layer.build(
      Layer.fresh(
        HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
          Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
        ),
      ),
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address))
      return yield* new ServerFailed({ message: "Control listener must use TCP" });
    yield* start;
    return { controlOrigin: `http://127.0.0.1:${server.address.port}`, origin };
  });

const startIsolatedSelfHost = (target: typeof Target.Service, entry: "product" | "development") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const port =
      entry === "product"
        ? 0
        : yield* Effect.scoped(
            Effect.gen(function* () {
              const services = yield* Layer.build(
                NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }),
              );
              const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
              if (!("port" in server.address))
                return yield* new ServerFailed({
                  message: "Isolated self-host listener must use TCP",
                });
              return server.address.port;
            }),
          );
    const directory = yield* fs.makeTempDirectory({ directory: target.directory, prefix: entry });
    const origin = `http://127.0.0.1:${port}`;
    const server = yield* startManagedServer(
      { ...target, directory, metadata: { ...target.metadata, origin, target: "self-host" } },
      entry,
    );
    return server.origin;
  });

/** Start the complete self-host development entry point beside the production test target. */
export const startDevelopmentServer = (target: typeof Target.Service) =>
  startIsolatedSelfHost(target, "development");

/** Start an unconfigured product instance; the scenario scope owns its process and fresh data. */
export const startFreshSelfHost = (target: typeof Target.Service) =>
  startIsolatedSelfHost(target, "product");
