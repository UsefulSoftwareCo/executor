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
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import type { Target } from "./platform.ts";
import { startAnalyticsCollector } from "./analytics-collector.ts";
import {
  applyLegacyStatements,
  LegacyResults,
  LegacyStatements,
  productDatabase,
} from "./legacy-storage.ts";
import { scenarios } from "../test-plan.ts";

class ServerFailed extends Schema.TaggedError<ServerFailed>()("ServerFailed", {
  message: Schema.String,
}) {}

/** The furthest a scenario may move a stopped product's clock; `wall-clock.mjs` enforces it too. */
const maxClockOffset = 40 * 86_400_000;
/** Operator settings a scenario may turn on between product generations. */
export const OperatorSettings = Schema.Struct({
  EXECUTOR_OAUTH_CLIENT_METADATA_URL: Schema.NonEmptyString,
});
/** The runner owns every process generation and keeps the same synthetic secrets across restarts. */
export const startManagedServer = (
  target: typeof Target.Service,
  mode: "product" | "development" = "product",
  /** Operator settings for this process, applied over the runner's own. */
  environment: Readonly<Record<string, string>> = {},
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
    // The suite's loopback registry serves this checkout's apps release; see npm-registry.ts.
    const npmRegistry = yield* Config.NonEmptyString("E2E_NPM_REGISTRY").pipe(Config.option);
    const entry =
      target.metadata.target === "local" && Option.isSome(packagedEntry)
        ? // Run the installed CLI from its package, as the desktop runs its backend from its
          // install root. Product processes can outlive the server's reported exit on Windows
          // while they terminate, and a working directory there cannot be removed.
          { command: [packagedEntry.value, "serve"], cwd: path.dirname(packagedEntry.value) }
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

    // Each product process sends its analytics to its own loopback collector, kept across restarts.
    const analyticsPort = yield* startAnalyticsCollector(target.directory);
    const gate = yield* Semaphore.make(1);
    let current: Scope.Closeable | undefined;
    /** The running product process, for an abrupt kill that runs none of its shutdown. */
    let running: ChildProcessSpawner.ChildProcessHandle | undefined;
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
            // Fixture providers listen on loopback, which the product default refuses to app code.
            EXECUTOR_APPS_ALLOW_PRIVATE_FETCH: "true",
          }
        : {}),
      EXECUTOR_ENVIRONMENT: "e2e",
      EXECUTOR_BUILD_VERSION: target.metadata.commit,
      EXECUTOR_WORKER_BUNDLE: path.resolve(".local/test-runtime/host.json"),
      ...(Option.isSome(npmRegistry) ? { EXECUTOR_NPM_REGISTRY: npmRegistry.value } : {}),
      EXECUTOR_TEST_CLOCK_OFFSET_MS: "0",
      EXECUTOR_ANALYTICS_TEST_PORT: String(analyticsPort),
      ...environment,
    };
    // On Windows every signal terminates at once, so the scope's tree kill stays the only stop.
    const stopRequests = process.platform !== "win32";
    // Ask the product alone to stop, as the self-host image's supervisor does, so its own shutdown
    // flushes its telemetry before it stops the collector it started. A signal to its whole
    // process group stopped the collector first, and the product then spent its 3-second export
    // budget retrying. Releasing the process scope afterwards ends anything it left behind.
    const shutdown = Effect.suspend(() => {
      const child = running;
      if (child === undefined || !stopRequests) return Effect.void;
      // The request goes through a pipe only the product holds (see stop-request.mjs), not to its
      // PID: once the product is reaped, its PID can name another process before its handle
      // reports the exit. A write to a product that already exited never completes, so the
      // product's exit ends the wait whether or not its request was delivered.
      const request = Stream.run(Stream.make(new Uint8Array([1])), child.getInputFd(3)).pipe(
        Effect.ignore,
        Effect.andThen(Effect.never),
      );
      return child.exitCode.pipe(
        Effect.ignore,
        Effect.raceFirst(request),
        Effect.timeoutOption("15 seconds"),
        Effect.flatMap((exited) =>
          Option.isSome(exited) ? Effect.void : child.kill({ killSignal: "SIGKILL" }),
        ),
        Effect.ignore,
      );
    });
    const stop = Effect.suspend(() =>
      current === undefined
        ? Effect.void
        : shutdown.pipe(
            Effect.andThen(Scope.close(current, Exit.succeed(undefined))),
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
              // Bun accepts Node's --import preload, so self-host can advance wall time too.
              "--import",
              new URL("./wall-clock.mjs", import.meta.url).href,
              ...(stopRequests
                ? ["--import", new URL("./stop-request.mjs", import.meta.url).href]
                : []),
              ...entry.command,
            ],
            {
              extendEnv: false,
              ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
              env,
              stdout: "pipe",
              stderr: "pipe",
              ...(stopRequests ? { additionalFds: { fd3: { type: "input" } } } : {}),
              killSignal: "SIGTERM",
              forceKillAfter: "15 seconds",
            },
          ),
        );
        running = child;
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            if (running === child) running = undefined;
          }),
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
    const control = (action: "start" | "stop" | "restart" | "kill") =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.headers.authorization !== `Bearer ${Redacted.value(target.apiKey)}`)
          return HttpServerResponse.empty({ status: 401 });
        yield* gate.withPermits(1)(
          Effect.gen(function* () {
            // A kill models a crash or out-of-memory stop: the whole process group ends at once.
            if (action === "kill" && running !== undefined)
              yield* running.kill({ killSignal: "SIGKILL" });
            if (action !== "start") yield* stop;
            if (action === "start" || action === "restart") yield* start;
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
                    Schema.isBetween({ minimum: 1, maximum: maxClockOffset }),
                  ),
                }),
              ),
            ),
          );
          return yield* gate.withPermits(1)(
            Effect.gen(function* () {
              if (current !== undefined) return HttpServerResponse.empty({ status: 409 });
              const offset = Number(env.EXECUTOR_TEST_CLOCK_OFFSET_MS) + body.milliseconds;
              if (offset > maxClockOffset) return HttpServerResponse.empty({ status: 400 });
              env.EXECUTOR_TEST_CLOCK_OFFSET_MS = String(offset);
              return HttpServerResponse.jsonUnsafe({ offset });
            }),
          );
        }),
      ),
      // A later start reads an operator setting the install did not have, as when an operator
      // turns it on. Only settings a scenario turns on mid-life are accepted.
      HttpRouter.add(
        "POST",
        "/environment",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.headers.authorization !== `Bearer ${Redacted.value(target.apiKey)}`)
            return HttpServerResponse.empty({ status: 401 });
          const body = yield* request.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(OperatorSettings)),
          );
          return yield* gate.withPermits(1)(
            Effect.sync(() => {
              if (current !== undefined) return HttpServerResponse.empty({ status: 409 });
              Object.assign(env, body);
              return HttpServerResponse.jsonUnsafe({ ok: true });
            }),
          );
        }),
      ),
      // A later start runs pending data steps in another mode.
      HttpRouter.add(
        "POST",
        "/data-steps",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.headers.authorization !== `Bearer ${Redacted.value(target.apiKey)}`)
            return HttpServerResponse.empty({ status: 401 });
          const body = yield* request.json.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({ mode: Schema.Literals(["report", "apply"]) }),
              ),
            ),
          );
          return yield* gate.withPermits(1)(
            Effect.sync(() => {
              if (current !== undefined) return HttpServerResponse.empty({ status: 409 });
              Object.assign(env, { EXECUTOR_DATA_STEPS: body.mode });
              return HttpServerResponse.jsonUnsafe({ ok: true });
            }),
          );
        }),
      ),
      HttpRouter.add(
        "POST",
        "/storage/legacy",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.headers.authorization !== `Bearer ${Redacted.value(target.apiKey)}`)
            return HttpServerResponse.empty({ status: 401 });
          // Only scenarios that declare this in the reviewed test plan may write rows directly.
          const declared = Object.values(scenarios).some(
            (scenario) =>
              scenario.title === target.scenarioLabel && scenario.legacyStorage === true,
          );
          if (!declared || target.metadata.target === "cloud")
            return HttpServerResponse.empty({ status: 403 });
          const database = productDatabase(env.EXECUTOR_DATA_DIR, target.metadata.target);
          const body = yield* request.json.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.Struct({ statements: LegacyStatements })),
            ),
          );
          // Hold the lifecycle gate so no product generation can open the database meanwhile.
          const rows = yield* gate.withPermits(1)(
            stop.pipe(Effect.andThen(applyLegacyStatements(database, body.statements))),
          );
          return HttpServerResponse.text(
            yield* Schema.encodeEffect(Schema.fromJsonString(LegacyResults))(rows),
          );
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed(
              error._tag === "LegacyStatementFailed"
                ? HttpServerResponse.text(
                    `Statement ${error.index} failed and was rolled back: ${error.message}`,
                    { status: 500 },
                  )
                : HttpServerResponse.empty({ status: 500 }),
            ),
          ),
        ),
      ),
      HttpRouter.add("POST", "/start", control("start")),
      HttpRouter.add("POST", "/stop", control("stop")),
      HttpRouter.add("POST", "/restart", control("restart")),
      HttpRouter.add("POST", "/kill", control("kill")),
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

const startIsolatedSelfHost = (
  target: typeof Target.Service,
  entry: "product" | "development",
  environment: Readonly<Record<string, string>> = {},
) =>
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
      environment,
    );
    return server.origin;
  });

/** Start the complete self-host development entry point beside the production test target. */
export const startDevelopmentServer = (target: typeof Target.Service) =>
  startIsolatedSelfHost(target, "development");

/** Start an unconfigured product instance; the scenario scope owns its process and fresh data. */
export const startFreshSelfHost = (
  target: typeof Target.Service,
  environment: Readonly<Record<string, string>> = {},
) => startIsolatedSelfHost(target, "product", environment);
