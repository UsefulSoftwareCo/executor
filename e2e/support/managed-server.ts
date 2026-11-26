import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  Clock,
  Config,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
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
  LegacyDatabase,
  legacyDatabase,
  LegacyResults,
  LegacyStatements,
} from "./legacy-storage.ts";
import { reservedPort } from "./ports.ts";
import { scenarios } from "../test-plan.ts";
import { recordWorkerdCoverage, workerdCoverageFlags } from "./workerd-coverage.ts";
import { localEntryCommand } from "./local-entry.ts";
import { reveal } from "./failure-text.ts";

class ServerFailed extends Schema.TaggedError<ServerFailed>()("ServerFailed", {
  message: Schema.String,
}) {}

const startupLinesQuoted = 20;

const maxClockOffset = 40 * 86_400_000;
export const OperatorSettings = Schema.Struct({
  EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: Schema.optionalKey(Schema.String),
  EXECUTOR_URL_ALLOW_HTTP_ORIGINS: Schema.optionalKey(Schema.String),
  NODE_EXTRA_CA_CERTS: Schema.optionalKey(Schema.NonEmptyString),
  SSO_DISCOVERY_URL: Schema.optionalKey(Schema.NonEmptyString),
  SSO_CLIENT_ID: Schema.optionalKey(Schema.NonEmptyString),
  SSO_CLIENT_SECRET: Schema.optionalKey(Schema.NonEmptyString),
  SSO_ALLOWED_DOMAINS: Schema.optionalKey(Schema.NonEmptyString),
  EXECUTOR_OAUTH_CLIENT_METADATA_URL: Schema.optionalKey(Schema.NonEmptyString),
  EXECUTOR_BUILD_VERSION: Schema.optionalKey(Schema.NonEmptyString),
  EXECUTOR_NPM_REGISTRY: Schema.optionalKey(Schema.NonEmptyString),
  EXECUTOR_TEST_COMPILER_UNAVAILABLE: Schema.optionalKey(Schema.Literals(["all", "retained", ""])),
  EXECUTOR_CATALOG_COPY_REBUILD_SCOPE: Schema.optionalKey(Schema.String),
  EXECUTOR_TEST_CATALOG_COPY_REBUILD_PACE: Schema.optionalKey(Schema.NonEmptyString),
  EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS: Schema.optionalKey(Schema.String),
  EXECUTOR_OAUTH_SYNTHETIC_MAIL_CLIENT_ID: Schema.optionalKey(Schema.String),
  EXECUTOR_OAUTH_SYNTHETIC_MAIL_CLIENT_SECRET: Schema.optionalKey(Schema.String),
  EXECUTOR_OAUTH_GOOGLE_CLIENT_ID: Schema.optionalKey(Schema.String),
  EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET: Schema.optionalKey(Schema.String),
  EXECUTOR_OAUTH_SLACK_CLIENT_ID: Schema.optionalKey(Schema.String),
  EXECUTOR_OAUTH_SLACK_CLIENT_SECRET: Schema.optionalKey(Schema.String),
});
export const serverProcessFile = "server-process.json";
export const ServerProcess = Schema.Struct({ processGroup: Schema.Number });

export const processGroupRunning = (group: number) =>
  Effect.sync(() => {
    try {
      process.kill(-group, 0);
      return true;
    } catch (error) {
      return error instanceof Error && "code" in error && error.code === "EPERM";
    }
  });

export const startManagedServer = (
  target: typeof Target.Service,
  mode: "product" | "development" = "product",
  environment: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      processes = yield* ChildProcessSpawner.ChildProcessSpawner,
      path = yield* Path.Path,
      http = yield* HttpClient.HttpClient;
    const requested = new URL(target.metadata.origin);
    const port = requested.port === "0" ? String(yield* reservedPort) : requested.port;
    let origin =
      requested.port === "0"
        ? `${requested.protocol}//${requested.hostname}:${port}`
        : target.metadata.origin;
    const runtimePath = yield* Config.String("EXECUTOR_E2E_RUNTIME_PATH").pipe(
      Config.withDefault(process.env.PATH ?? ""),
    );
    const packagedEntry = yield* Config.NonEmptyString("EXECUTOR_E2E_LOCAL_ENTRY").pipe(
      Config.option,
    );
    const npmRegistry = yield* Config.NonEmptyString("E2E_NPM_REGISTRY").pipe(Config.option);
    const catalogs = yield* Config.NonEmptyString("E2E_PUBLIC_CATALOGS").pipe(Config.option);
    const entry =
      target.metadata.target === "local" && Option.isSome(packagedEntry)
        ? { command: [packagedEntry.value, "serve"], cwd: path.dirname(packagedEntry.value) }
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

    const analyticsPort = yield* startAnalyticsCollector(target.directory);
    const gate = yield* Semaphore.make(1);
    const coverageDirectory =
      (yield* Config.Boolean("E2E_COVERAGE").pipe(Config.withDefault(false))) &&
      target.scenarioId !== undefined
        ? path.join(target.evidenceDirectory ?? target.directory, "coverage", target.scenarioId)
        : undefined;
    if (coverageDirectory !== undefined) {
      yield* fs.makeDirectory(coverageDirectory, { recursive: true });
      yield* fs.writeFileString(
        path.join(coverageDirectory, "scenario.json"),
        JSON.stringify({ target: target.metadata.target, title: target.scenarioLabel }),
      );
    }
    let generation = 0;
    let confirmedOffset = 0;
    let current: Scope.Closeable | undefined;
    let running: ChildProcessSpawner.ChildProcessHandle | undefined;
    let exitLine: Deferred.Deferred<void> | undefined;
    let saveWorkerdCoverage: Effect.Effect<void> = Effect.void;
    const env = {
      PATH: runtimePath,
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: port,
      EXECUTOR_PORT: port,
      EXECUTOR_API_KEY: reveal(target.apiKey),
      EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      EXECUTOR_DATA_DIR: `${target.directory}/data`,
      BETTER_AUTH_URL: target.metadata.origin,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      ...(target.metadata.target === "self-host"
        ? {
            EXECUTOR_OAUTH_CALLBACK_URL: `http://account-picker.localhost:${port}/api/oauth/callback?tenant=fixture`,
            EXECUTOR_URL_ALLOW_HTTP_ORIGINS: '["http://oauth.internal:8080"]',
            EXECUTOR_APPS_ALLOW_PRIVATE_FETCH: "true",
          }
        : {}),
      EXECUTOR_ENVIRONMENT: "e2e",
      EXECUTOR_BUILD_VERSION: target.metadata.commit,
      EXECUTOR_WORKER_BUNDLE: path.resolve(".local/test-runtime/host.json"),
      ...(Option.isSome(npmRegistry) ? { EXECUTOR_NPM_REGISTRY: npmRegistry.value } : {}),
      ...(Option.isSome(catalogs)
        ? {
            EXECUTOR_CATALOG_URL: `${catalogs.value}/catalog/index.json`,
            EXECUTOR_REGISTRY_URL: catalogs.value,
          }
        : {}),
      EXECUTOR_TEST_CLOCK_OFFSET_MS: "0",
      EXECUTOR_TEST_CLOCK_CONTROL: "stdin",
      EXECUTOR_ANALYTICS_TEST_PORT: String(analyticsPort),
      ...(process.env.NODE_EXTRA_CA_CERTS === undefined
        ? {}
        : { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }),
      ...environment,
    };
    const shutdown = Effect.suspend(() => {
      const child = running;
      if (child === undefined) return Effect.succeed(undefined);
      const exited = exitLine;
      return Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const [stopped] = yield* Effect.all(
          [
            Effect.raceFirst(
              child.exitCode.pipe(Effect.ignore),
              exited === undefined ? Effect.never : Deferred.await(exited),
            ).pipe(
              Effect.andThen(Clock.currentTimeMillis),
              Effect.map((now) => now - started),
              Effect.timeoutOption("15 seconds"),
            ),
            stopProduct(child),
          ],
          { concurrency: "unbounded" },
        );
        yield* saveWorkerdCoverage;
        return Option.getOrUndefined(stopped);
      });
    });
    const stopProduct = (child: ChildProcessSpawner.ChildProcessHandle) => {
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
    };
    const stop = Effect.suspend(() => {
      const closing = current;
      return closing === undefined
        ? Effect.succeed(undefined)
        : shutdown.pipe(
            Effect.tap(() => Scope.close(closing, Exit.succeed(undefined))),
            Effect.tap(() =>
              Effect.sync(() => {
                current = undefined;
              }),
            ),
          );
    });
    yield* Effect.addFinalizer(() => stop);
    const start = Effect.gen(function* () {
      if (current !== undefined) return;
      const scope = yield* Scope.make();
      current = scope;
      yield* Effect.gen(function* () {
        const preloads = ["./wall-clock.mjs", "./stop-request.mjs"].map(
          (file) => new URL(file, import.meta.url),
        );
        const coverage =
          coverageDirectory === undefined
            ? undefined
            : path.join(coverageDirectory, String(generation++));
        if (coverage !== undefined) yield* fs.makeDirectory(coverage, { recursive: true });
        const [program = "", ...programArgs] = entry.command;
        const launch =
          target.metadata.target === "local"
            ? localEntryCommand(program, programArgs)
            : {
                command: "bun",
                args:
                  coverage !== undefined && mode === "product"
                    ? [
                        "test",
                        "--coverage",
                        "--coverage-reporter=lcov",
                        `--coverage-dir=${coverage}`,
                        "--timeout=0",
                        ...(yield* Effect.forEach(preloads, path.fromFileUrl).pipe(
                          Effect.orDie,
                        )).flatMap((file) => ["--preload", file]),
                        "./apps/hosted/self-host/scripts/coverage-main.ts",
                      ]
                    : [...preloads.flatMap((url) => ["--import", url.href]), ...entry.command],
              };
        const child = yield* processes.spawn(
          ChildProcess.make(launch.command, launch.args, {
            extendEnv: false,
            ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
            env: {
              ...env,
              ...(target.metadata.target === "local" ? { EXECUTOR_TEST_STOP_FD: "3" } : {}),
              ...(coverage === undefined
                ? {}
                : { ALCHEMY_WORKERD_V8_FLAGS: workerdCoverageFlags(coverage) }),
              ...(coverage !== undefined && target.metadata.target === "local"
                ? { NODE_V8_COVERAGE: coverage }
                : {}),
            },
            stdin: { stream: "pipe", endOnDone: false },
            stdout: "pipe",
            stderr: "pipe",
            additionalFds: { fd3: { type: "input" } },
            killSignal: "SIGTERM",
            forceKillAfter: "15 seconds",
          }),
        );
        running = child;
        yield* fs
          .writeFileString(
            `${target.directory}/${serverProcessFile}`,
            JSON.stringify({ processGroup: child.pid }),
            { mode: 0o600 },
          )
          .pipe(Effect.orDie);
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            if (running === child) running = undefined;
          }),
        );
        if (coverage !== undefined) {
          const recorder = yield* recordWorkerdCoverage({
            directory: coverage,
            bundle: env.EXECUTOR_WORKER_BUNDLE,
          });
          saveWorkerdCoverage = recorder.save;
          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              if (saveWorkerdCoverage === recorder.save) saveWorkerdCoverage = Effect.void;
            }),
          );
        }
        const ready = yield* Deferred.make<void>();
        const exited = yield* Deferred.make<void>();
        exitLine = exited;
        const lastLines: Array<string> = [];
        const output = yield* Stream.merge(child.stdout, child.stderr).pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) =>
            Effect.gen(function* () {
              if (line.includes('"message":"Local server exited"'))
                yield* Deferred.succeed(exited, undefined);
              const redacted = line.replace(/#pair=[a-f0-9]{64}/g, "#pair=<redacted>");
              lastLines.push(redacted);
              if (lastLines.length > startupLinesQuoted) lastLines.shift();
              yield* fs.writeFileString(`${target.directory}/server.log`, `${redacted}\n`, {
                flag: "a",
                mode: 0o600,
              });
              const clock = /^Executor test clock: (\d+)$/.exec(line);
              if (clock !== null) confirmedOffset = Number(clock[1]);
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
              Fiber.join(output).pipe(
                Effect.timeoutOption("3 seconds"),
                Effect.andThen(
                  Effect.suspend(() =>
                    Effect.fail(
                      new ServerFailed({
                        message: `Server exited before readiness (${code}) on port ${env.PORT}; its last output:\n${lastLines.length === 0 ? "(none)" : lastLines.join("\n")}`,
                      }),
                    ),
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
        if (request.headers.authorization !== `Bearer ${reveal(target.apiKey)}`)
          return HttpServerResponse.empty({ status: 401 });
        const stopped = yield* gate.withPermits(1)(
          Effect.gen(function* () {
            if (action === "kill" && running !== undefined) {
              yield* running.kill({ killSignal: "SIGKILL" });
              yield* saveWorkerdCoverage;
            }
            const stopped = action === "start" ? undefined : yield* stop;
            if (action === "start" || action === "restart") yield* start;
            return stopped;
          }),
        );
        return HttpServerResponse.jsonUnsafe(
          action === "stop" && stopped !== undefined
            ? { ok: true, stoppedMs: stopped }
            : { ok: true },
        );
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 500 }))));
    const routes = Layer.mergeAll(
      HttpRouter.add(
        "POST",
        "/clock/advance",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.headers.authorization !== `Bearer ${reveal(target.apiKey)}`)
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
              const offset = Number(env.EXECUTOR_TEST_CLOCK_OFFSET_MS) + body.milliseconds;
              if (offset > maxClockOffset) return HttpServerResponse.empty({ status: 400 });
              env.EXECUTOR_TEST_CLOCK_OFFSET_MS = String(offset);
              if (running !== undefined) {
                yield* Stream.run(
                  Stream.make(new TextEncoder().encode(`clock ${offset}\n`)),
                  running.stdin,
                );
                yield* Effect.sync(() => confirmedOffset).pipe(
                  Effect.filterOrFail((confirmed) => confirmed === offset),
                  Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 400 }),
                );
              }
              return HttpServerResponse.jsonUnsafe({ offset });
            }),
          );
        }),
      ),
      HttpRouter.add(
        "POST",
        "/environment",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.headers.authorization !== `Bearer ${reveal(target.apiKey)}`)
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
      HttpRouter.add(
        "POST",
        "/data-steps",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.headers.authorization !== `Bearer ${reveal(target.apiKey)}`)
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
          if (request.headers.authorization !== `Bearer ${reveal(target.apiKey)}`)
            return HttpServerResponse.empty({ status: 401 });
          const declared = Object.values(scenarios).some(
            (scenario) =>
              scenario.title === target.scenarioLabel && scenario.legacyStorage === true,
          );
          if (!declared || target.metadata.target === "cloud")
            return HttpServerResponse.empty({ status: 403 });
          const body = yield* request.json.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({ statements: LegacyStatements, database: LegacyDatabase }),
              ),
            ),
          );
          const database = legacyDatabase(
            env.EXECUTOR_DATA_DIR,
            target.metadata.target,
            body.database,
          );
          if (database === undefined) return HttpServerResponse.empty({ status: 403 });
          const rows = yield* gate.withPermits(1)(
            stop.pipe(
              Effect.andThen(
                applyLegacyStatements(database, body.statements, env.EXECUTOR_ENCRYPTION_KEY),
              ),
            ),
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
    const port = yield* reservedPort;
    const directory = yield* fs.makeTempDirectory({ directory: target.directory, prefix: entry });
    const origin = `http://127.0.0.1:${port}`;
    const server = yield* startManagedServer(
      { ...target, directory, metadata: { ...target.metadata, origin, target: "self-host" } },
      entry,
      environment,
    );
    return { ...server, directory };
  });

export const startDevelopmentServer = (
  target: typeof Target.Service,
  environment: Readonly<Record<string, string>> = {},
) =>
  startIsolatedSelfHost(target, "development", environment).pipe(
    Effect.map(({ origin }) => origin),
  );

export const startFreshSelfHost = (
  target: typeof Target.Service,
  environment: Readonly<Record<string, string>> = {},
) => startIsolatedSelfHost(target, "product", environment).pipe(Effect.map(({ origin }) => origin));

export const startLoggedSelfHost = (
  target: typeof Target.Service,
  environment: Readonly<Record<string, string>> = {},
) =>
  startIsolatedSelfHost(target, "product", environment).pipe(
    Effect.map(({ origin, directory }) => ({ origin, log: `${directory}/server.log` })),
  );

export const startControlledSelfHost = (
  target: typeof Target.Service,
  environment: Readonly<Record<string, string>> = {},
) =>
  startIsolatedSelfHost(target, "product", environment).pipe(
    Effect.map(({ origin, controlOrigin, directory }): typeof Target.Service => ({
      ...target,
      directory,
      controlOrigin,
      metadata: { ...target.metadata, origin, target: "self-host" },
    })),
  );
