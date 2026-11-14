/**
 * `executor serve`: this data directory's Executor server, in one of three modes.
 *
 * - `foreground` serves until interrupted and prints how to connect.
 * - `service` is the background service a client starts detached. It runs with its saved
 *   settings, prints nothing, and serves until asked to stop.
 * - `stdio` is a private server for one parent. It prints its URL as one JSON line once ready
 *   and stops when its standard input closes.
 *
 * Every mode listens before anything else and holds the data directory's lock before opening
 * storage; only a running Executor from before the background service, which holds no lock, is
 * checked first. Foreground and service servers register in `server.json`, so local clients share
 * them.
 * Adapted from OpenCode (MIT, Copyright (c) 2025 opencode).
 */
import { homedir } from "node:os";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import {
  Config,
  ConfigProvider,
  Console,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
  Scope,
  Stdio,
  Stream,
} from "effect";
import { Base64Url } from "effect/encoding";
import { HttpClient, HttpClientResponse } from "effect/http";
import { listenPortConfig } from "../contracts/config.ts";
import { LocalConfigurationError, type LocalConfigurationReason } from "../contracts/auth.ts";
import {
  ServiceFailed,
  ServiceInfo,
  ServiceRefusal,
  ServiceRegistration,
  serviceInfoPath,
  servicePasswordVariable,
} from "../contracts/service.ts";
import { StartupFailed } from "../contracts/startup.ts";
import {
  composeLocalServer,
  listenLocal,
  localServices,
  lockDataDirectory,
  reportStartupFailure,
  type LocalListener,
} from "../node.ts";
import { keyStorageSetting, localConfiguration } from "./bootstrap.ts";
import { ownProcess, ownProcessUnread } from "./process-identity.ts";
import {
  answersAs,
  readRegistration,
  readSettings,
  refuseEarlierServer,
  registeredServerRuns,
  removeRegistration,
  sameRegistration,
  serviceChallenge,
  serviceDirectory,
  writeRegistration,
} from "./service-files.ts";
import { updateNotice } from "./update-notice.ts";

/** How `executor serve` runs: in the foreground, as the background service, or for one parent. */
export type ServeMode = "foreground" | "service" | "stdio";

/** Another process listens on the port. */
const inUse = (error: unknown) =>
  Schema.is(StartupFailed)(error) && error.stage === "listen" && error.code === "EADDRINUSE";

/** The port this server listens on, and whether EXECUTOR_PORT chose it over the `port` setting. */
interface Listening {
  readonly port: number;
  readonly variable: boolean;
}

const portInUse = (listening: Listening, executor = false) =>
  new ServiceFailed({
    reason: "port-in-use",
    detail: String(listening.port),
    ...(listening.variable ? { variable: true } : {}),
    ...(executor ? { executor: true } : {}),
  });

/** A `--standalone` parent chooses its child's password; it must not stay in the environment. */
const parentPassword = Config.schema(
  Schema.Redacted(Schema.String.check(Schema.isMinLength(32))),
  servicePasswordVariable,
).pipe(
  Effect.mapError(
    () =>
      new LocalConfigurationError({
        reason: "misconfigured",
        message: `\`executor serve --stdio\` needs ${servicePasswordVariable}: a password of at least 32 characters chosen by the process that starts it. Nothing was started.`,
      }),
  ),
);

/**
 * Who answers on `url`: this directory's registered server, which proves it with the registration's
 * password, another Executor server, or a program that is not one. `silent` when nothing answers
 * within a second.
 */
const answering = (directory: string, url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const challenge = yield* serviceChallenge;
    const response = yield* client.get(`${url}${serviceInfoPath}?challenge=${challenge}`);
    const info = yield* HttpClientResponse.schemaBodyJson(ServiceInfo)(response).pipe(
      Effect.option,
    );
    if (Option.isNone(info)) return "foreign";
    const registration = yield* readRegistration(directory);
    return Option.isSome(registration) &&
      registration.value.url === url &&
      (yield* answersAs(registration.value, info.value, challenge))
      ? "registered"
      : "executor";
  }).pipe(
    Effect.timeout("1 second"),
    Effect.orElseSucceed(() => "silent" as const),
    Effect.provide(NodeHttpClient.layerNodeHttp),
  );

/**
 * Listen in the foreground or for one parent. A port this directory's registered server holds
 * means the directory is in use, not that another program took the port, also while that server is
 * too busy or suspended to answer. Only a registration naming this URL can mean that, so a
 * program on a port no registration names is not probed.
 */
const listenOwn = (directory: string, listening: Listening, password: Redacted.Redacted<string>) =>
  listenLocal({ port: listening.port, password }).pipe(
    Effect.catchIf(inUse, () =>
      Effect.gen(function* () {
        const url = `http://127.0.0.1:${listening.port}`;
        const registration = yield* readRegistration(directory);
        if (Option.isNone(registration) || registration.value.url !== url)
          return yield* portInUse(listening);
        const answer = yield* answering(directory, url);
        return yield* answer === "registered" ||
        (answer === "silent" && (yield* registeredServerRuns(directory, registration.value)))
          ? new ServiceFailed({ reason: "directory-in-use", detail: directory, url })
          : portInUse(listening, answer === "executor");
      }),
    ),
  );

/**
 * Listen as the background service. Clients that race to start it choose the same port, so the
 * port decides between their servers. One that finds the port taken by another program fails at
 * once. Otherwise it waits up to 15 seconds: it exits quietly, returning `undefined`, once this
 * directory's registered server answers there, and takes the port if it comes free. An Executor
 * server that still holds it then serves another data directory.
 */
const listenService = (
  directory: string,
  listening: Listening,
  password: Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    const { port } = listening;
    const scope = yield* Effect.scope;
    // Each attempt owns its socket, closed when the attempt fails.
    const attempt = Scope.fork(scope).pipe(
      Effect.flatMap((child) =>
        listenLocal({ port, password }).pipe(
          Scope.provide(child),
          Effect.onError(() => Scope.close(child, Exit.void)),
        ),
      ),
    );
    const first = yield* attempt.pipe(
      Effect.map(Option.some),
      Effect.catchIf(inUse, () => Effect.succeedNone),
    );
    if (Option.isSome(first)) return first.value;
    const url = `http://127.0.0.1:${port}`;
    let executor = false;
    const waited = yield* Effect.gen(function* () {
      const answer = yield* answering(directory, url);
      if (answer === "registered") return undefined;
      // An Executor server that is starting or stopping answers its info route at once.
      if (answer === "foreign") return yield* portInUse(listening);
      executor = answer === "executor";
      yield* Effect.sleep("100 millis");
      return yield* attempt;
    }).pipe(Effect.retry({ while: inUse }), Effect.timeoutOption("15 seconds"));
    if (Option.isNone(waited)) return yield* portInUse(listening, executor);
    return waited.value;
  });

/**
 * What identifies a file: its device, inode, size and modification time, as far as the platform
 * reports them. None once it cannot be read, as after it was removed.
 */
const fileIdentity = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(file);
    return [
      info.dev,
      Option.getOrUndefined(info.ino),
      info.size,
      Option.getOrUndefined(info.mtime)?.getTime(),
    ].join(":");
  }).pipe(Effect.option);

/**
 * Advertise this server in `server.json` before opening storage, so clients wait for it instead of
 * starting another. Every 5 seconds it checks that the file still names it and that its executable
 * is still the file it started from, and stops once either is not.
 * `group`: this server leads its own process group, as a client starts a background server.
 */
const register = (
  platform: string,
  directory: string,
  listener: LocalListener,
  password: Redacted.Redacted<string>,
  group: boolean,
) =>
  Effect.gen(function* () {
    const browserOrigin = yield* Config.String("EXECUTOR_BROWSER_ORIGIN").pipe(Config.option);
    const registration = ServiceRegistration.make({
      id: listener.id,
      version: listener.version,
      url: listener.url,
      // The same process record the lock holds, so a client can tell this process from another
      // that is later given its pid.
      ...(yield* ownProcess),
      password: Redacted.value(password),
      ...(group ? { group: true } : {}),
      ...(Option.isSome(browserOrigin) ? { browserOrigin: browserOrigin.value } : {}),
    });
    yield* writeRegistration(platform, directory, registration);
    yield* Effect.addFinalizer(() =>
      removeRegistration(directory, registration).pipe(Effect.ignore),
    );
    const owned = readRegistration(directory).pipe(
      Effect.map(
        (current) =>
          Option.isSome(current) &&
          sameRegistration(current.value, registration) &&
          current.value.password === registration.password,
      ),
    );
    yield* owned.pipe(
      Effect.repeat({ schedule: Schedule.spaced("5 seconds"), while: (owns) => owns }),
      Effect.andThen(Effect.logWarning("Local server registration was replaced or removed")),
      Effect.andThen(listener.stop("registration replaced")),
      Effect.forkScoped,
    );
    // The release executable, or the Node or Bun that runs the CLI, as it was at the start.
    // `brew upgrade`, `npm i -g` and the install script remove or replace it and the runtime files
    // beside it without stopping this server, so it stops then and the next client starts the
    // version installed now. `executor upgrade` stops the server itself first.
    const fs = yield* FileSystem.FileSystem;
    const executable = yield* fs.realPath(process.execPath).pipe(Effect.option);
    const started = Option.isSome(executable)
      ? yield* fileIdentity(executable.value)
      : Option.none<string>();
    const unchanged = Effect.gen(function* () {
      if (Option.isNone(executable) || Option.isNone(started)) return false;
      const current = yield* fileIdentity(executable.value);
      return Option.isSome(current) && current.value === started.value;
    });
    yield* unchanged.pipe(
      Effect.repeat({ schedule: Schedule.spaced("5 seconds"), while: (same) => same }),
      Effect.andThen(
        Effect.logWarning("Local server executable was replaced or removed").pipe(
          Effect.annotateLogs({ executable: process.execPath }),
        ),
      ),
      Effect.andThen(listener.stop("executable replaced")),
      Effect.forkScoped,
    );
  });

/**
 * Tell the client that started this background or private server why its key setup or data
 * directory refused to start, as one ServiceRefusal line on stderr. The error's own message follows.
 */
const reportRefusal =
  (mode: ServeMode) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapError((error) => {
        const reason: LocalConfigurationReason | undefined = Schema.is(LocalConfigurationError)(
          error,
        )
          ? error.reason
          : Schema.is(ServiceFailed)(error) && error.reason === "directory-in-use"
            ? "locked"
            : undefined;
        if (mode === "foreground" || reason === undefined) return Effect.void;
        return Schema.encodeEffect(ServiceRefusal)({ executorService: "refused", reason }).pipe(
          Effect.flatMap(Console.error),
          Effect.ignore,
        );
      }),
    );

const inputClosedReason = "standard input closed";
/** Serve until a parent closes standard input. Its clock control still reads the same input. */
const inputClosed = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  yield* stdio.stdin.pipe(Stream.runDrain, Effect.ignore);
  return inputClosedReason;
});

/**
 * A data directory whose lock another process holds is in use by the registered server when that
 * server proves it answers at its URL, or, when nothing answers in time, as from a server that is
 * hung or suspended, while the registered process still runs. Otherwise the holder is not
 * registered.
 */
const holderUrl = (directory: string) =>
  Effect.gen(function* () {
    const registration = yield* readRegistration(directory);
    if (Option.isNone(registration)) return undefined;
    const { url } = registration.value;
    const answer = yield* answering(directory, url);
    return answer === "registered" ||
      (answer === "silent" && (yield* registeredServerRuns(directory, registration.value)))
      ? url
      : undefined;
  });

const serve = (
  options: { readonly mode: ServeMode; readonly platform: string; readonly entry?: string },
  directory: string,
  listening: Listening,
  password: Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    // On Linux and macOS the lock and the registration record this process's start time, which
    // macOS reads with `ps`, so it is read while the server starts listening. Windows records none.
    yield* Effect.forkScoped(ownProcess);
    // Diagnostics create the data directory, so a setting that would refuse it is read first. The
    // client that started this server learns why, as for every other key setup refusal.
    yield* keyStorageSetting.pipe(reportRefusal(options.mode));
    // Diagnostics start before listening, so a failure to listen is recorded. The collector runs
    // in the scope that holds the data directory, and stops before the lock is released.
    const locked = yield* Deferred.make<Scope.Scope>();
    const services = yield* Layer.build(
      // Only a foreground server logs to stderr; a client reads a private server's for its reason.
      localServices(directory, {
        stderr: options.mode === "foreground",
        collectorScope: Deferred.await(locked),
      }),
    );
    return yield* Effect.gen(function* () {
      // Without its start time this server's lock and registration name only its pid, so another
      // process takes its lock over only once it is stale, and never signals it. That is said
      // once, in the diagnostics log and on stderr, which only a foreground server logs to.
      // Windows reads no start time: the pipe its lock records names this server instead.
      yield* ownProcessUnread.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (error) =>
              Effect.logWarning("This server could not read its own start time").pipe(
                Effect.annotateLogs({ detail: error.detail }),
                Effect.andThen(
                  options.mode === "foreground"
                    ? Effect.void
                    : Console.error(
                        `Executor could not read this server's start time (${error.detail}). Another Executor takes over its data directory only 30 seconds after it stops refreshing its lock.`,
                      ),
                ),
              ),
          }),
        ),
        Effect.forkScoped,
      );
      // A background server keeps no working directory someone may want to remove.
      if (options.mode === "service")
        yield* Effect.try(() => process.chdir(homedir())).pipe(
          Effect.catch(() =>
            Effect.logWarning("Background server could not change to the home directory"),
          ),
        );
      // An Executor from before the background service holds no lock, and may hold the port.
      yield* refuseEarlierServer(directory).pipe(reportRefusal(options.mode));
      const listener =
        options.mode === "service"
          ? yield* listenService(directory, listening, password)
          : yield* listenOwn(directory, listening, password);
      if (listener === undefined)
        return yield* Effect.logInfo("This directory's background server is already running");
      const held = yield* lockDataDirectory(directory, { port: listener.port }).pipe(
        Effect.catchIf(
          (error) => Schema.is(ServiceFailed)(error) && error.reason === "directory-in-use",
          (error) =>
            holderUrl(directory).pipe(
              Effect.flatMap((url) =>
                Effect.fail(
                  url === undefined
                    ? error
                    : new ServiceFailed({ reason: "directory-in-use", detail: directory, url }),
                ),
              ),
            ),
        ),
        reportRefusal(options.mode),
      );
      yield* Deferred.succeed(locked, yield* Effect.scope);
      yield* held.lost.pipe(
        Effect.andThen(listener.stop("data directory lock lost")),
        Effect.forkScoped,
      );
      if (options.mode !== "stdio")
        yield* register(
          options.platform,
          directory,
          listener,
          password,
          options.mode === "service",
        );
      const settings = yield* localConfiguration(options.platform).pipe(
        reportRefusal(options.mode),
      );
      // A development desktop serves the dashboard through Vite. Release bundles define this
      // variable as "0", which leaves Vite out of them.
      const web =
        process.env.EXECUTOR_DESKTOP_DEV === "1"
          ? yield* Effect.promise(() => import("./development.ts")).pipe(
              Effect.flatMap(({ developmentWeb }) =>
                developmentWeb(settings, { cacheDir: ".local/vite-desktop" }),
              ),
            )
          : undefined;
      const server = yield* composeLocalServer(
        listener,
        { ...settings, password },
        { product: "cli", web },
      );
      switch (options.mode) {
        case "foreground": {
          const link = yield* server.issuePairingLink;
          const origin = settings.browserOrigin ?? server.url;
          yield* Console.log(
            `Executor: ${origin}\nMCP: ${origin}/mcp\nConnect (one use, expires in 5 minutes):\n${Redacted.value(link.url)}`,
          );
          yield* Effect.forkScoped(updateNotice(directory, options.entry));
          break;
        }
        case "stdio":
          // The parent reads this one line; the password it chose authenticates everything else.
          // Connection links point at the browser origin, when one is configured.
          yield* Console.log(
            JSON.stringify({
              url: server.url,
              ...(settings.browserOrigin === undefined
                ? {}
                : { browserOrigin: settings.browserOrigin }),
            }),
          );
          break;
        case "service":
          break;
      }
      const reason = yield* options.mode === "stdio"
        ? Effect.raceFirst(listener.stopped, inputClosed)
        : listener.stopped;
      yield* Effect.logInfo("Local server stopping").pipe(Effect.annotateLogs({ reason }));
      // The parent passes this through, so its user learns why its private server stopped.
      if (options.mode === "stdio" && reason !== inputClosedReason)
        yield* Console.error(`Executor stopped: ${reason}.`);
    }).pipe(reportStartupFailure, Effect.provideContext(services));
  });

/**
 * Run this data directory's server until it stops: interrupted, asked to stop, replaced in
 * `server.json`, or, for `stdio`, when its parent closes standard input. Every finalizer runs
 * before this completes. `entry` is the script that started the CLI, for the update notice.
 */
export const serveProcess = (options: {
  readonly mode: ServeMode;
  readonly platform: string;
  readonly entry?: string;
}) =>
  Effect.gen(function* () {
    const directory = yield* serviceDirectory;
    const settings = yield* readSettings(directory);
    const variable = Option.isSome(yield* Config.String("EXECUTOR_PORT").pipe(Config.option));
    const port = yield* listenPortConfig(settings.port).pipe(
      Effect.mapError(
        () =>
          new LocalConfigurationError({
            reason: "misconfigured",
            message:
              "EXECUTOR_PORT must be a port number from 0 to 65535, where 0 chooses any free port. Nothing was started.",
          }),
      ),
    );
    const password =
      options.mode === "stdio"
        ? yield* parentPassword
        : yield* Effect.sync(() =>
            Redacted.make(Base64Url.encode(globalThis.crypto.getRandomValues(new Uint8Array(32)))),
          );
    yield* Effect.sync(() => {
      // Tools and apps this server runs inherit its environment, which never holds the password.
      delete process.env[servicePasswordVariable];
      if (options.mode !== "service") return;
      // The background server runs with its saved environment. Its data directory stays the
      // absolute one its client chose, whatever that environment or the working directory say.
      Object.assign(process.env, settings.env, { EXECUTOR_DATA_DIR: directory });
      // The client that started it stops reading these pipes once it has started.
      process.stdout.on("error", () => {});
      process.stderr.on("error", () => {});
    });
    // Configuration read from here on sees the environment as just changed.
    return yield* Effect.scoped(serve(options, directory, { port, variable }, password)).pipe(
      Effect.provideServiceEffect(
        ConfigProvider.ConfigProvider,
        Effect.sync(() => ConfigProvider.fromEnv()),
      ),
      // Every finalizer has run once a server stops. A handle a library left open must not keep
      // its process running, as one did on Windows after a stop request; the timer holds nothing.
      Effect.tap(() =>
        Effect.sync(() => {
          setTimeout(() => process.exit(), 1_000).unref();
        }),
      ),
    );
  });
