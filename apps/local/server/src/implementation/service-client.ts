/**
 * Find, start and stop the background Executor that serves one data directory, or run a private
 * server for one command. A client trusts `server.json` only once the server's unauthenticated
 * info route answers as the registered process. `ensure` starts detached `serve --service`
 * contenders until one registers; the fixed port and the server lock decide which one serves, and
 * the others exit. Nothing here installs an OS service or login item.
 * Adapted from OpenCode (MIT, Copyright (c) 2025 opencode).
 */
import { spawn } from "node:child_process";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import {
  Clock,
  ConfigProvider,
  Console,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Path,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { Hex } from "effect/encoding";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  keyStorageConfig,
  keyStorageInvalid,
  type LocalConfigurationReason,
} from "../contracts/auth.ts";
import {
  ServiceFailed,
  ServiceInfo,
  type ServiceRegistration,
  ServiceRefusal,
  serviceInfoPath,
  servicePasswordVariable,
  serviceStopPath,
} from "../contracts/service.ts";
import { processExists } from "./process-identity.ts";
import {
  answersAs,
  readRegistration,
  readSettings,
  refuseEarlierServer,
  registeredProcess,
  registeredServerRuns,
  removeRegistration,
  sameRegistration,
  serviceChallenge,
  serviceVersion,
} from "./service-files.ts";

const timing = {
  /** A new server registers within a few hundred milliseconds, so polling is frequent. */
  poll: Duration.millis(25),
  /** How long one info or stop request may take. */
  request: Duration.seconds(2),
  /** How long a registration that does not answer gets before another contender competes. */
  spawnDelay: 5_000,
  /** The delay doubles to this while contenders exit cleanly because another one won. */
  maxSpawnDelay: 30_000,
  /** Wall-clock bound on `ensure`; probes run one at a time, so attempts would drift. */
  deadline: Duration.minutes(2),
  exitPoll: Duration.millis(50),
  exitPolls: 100,
};
/** Consecutive timeouts after which a registered server counts as hung. */
const hungAfter = 3;
/** How much of a failed contender's stderr its error keeps. */
const stderrLimit = 8 * 1024;

/** A server that answered as the registered process. Its password works as the local API key. */
export interface RunningService {
  readonly url: string;
  readonly version: string;
  readonly pid: number;
  readonly password: Redacted.Redacted<string>;
  /** Where its connection links point instead of `url`, when it has a browser origin. */
  readonly browserOrigin?: string | undefined;
}

const running = (registration: ServiceRegistration): RunningService => ({
  url: registration.url,
  version: registration.version,
  pid: registration.pid,
  password: Redacted.make(registration.password),
  browserOrigin: registration.browserOrigin,
});

/**
 * What the registered address said. `ready`, `starting` and `stopping` proved they are the
 * registered process. `incompatible` answered without this release's info route. `silent` did not
 * answer as the registered process: nothing listens, another process answered or could not prove
 * it is the registered one, or the request timed out.
 */
type Answer =
  | { readonly state: "ready" | "starting" | "stopping" | "incompatible" }
  | { readonly state: "silent"; readonly timedOut: boolean };

const silent = (timedOut: boolean): Answer => ({ state: "silent", timedOut });

/** The registered process is not there: nothing listens, or another program answered at once. */
const absent = (answer: Answer) =>
  answer.state === "incompatible" || (answer.state === "silent" && !answer.timedOut);

/**
 * Ask the registered address who serves it, trusting only an answer that proves, with a fresh
 * challenge, that it holds the registration's password. The password itself is never sent.
 */
const probe = (registration: ServiceRegistration) =>
  Effect.gen(function* () {
    const challenge = yield* serviceChallenge;
    const response = yield* HttpClient.get(
      `${registration.url}${serviceInfoPath}?challenge=${challenge}`,
    );
    if (response.status !== 200 && response.status !== 503)
      return { state: "incompatible" } satisfies Answer;
    const info = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ServiceInfo)),
      Effect.option,
    );
    if (Option.isNone(info)) return { state: "incompatible" } satisfies Answer;
    // A process that is not the registered one, such as a successor that reused its port or one
    // that replays what the registered server once answered.
    if (!(yield* answersAs(registration, info.value, challenge))) return silent(false);
    return { state: info.value.status } satisfies Answer;
  }).pipe(
    Effect.timeout(timing.request),
    Effect.catchTag("TimeoutError", () => Effect.succeed(silent(true))),
    Effect.catchTag("HttpClientError", () => Effect.succeed(silent(false))),
    // node:http destroys an unanswered connection on timeout.
    Effect.provide(NodeHttpClient.layerNodeHttp),
  );

/**
 * The registered server: `ready`, `starting` or `stopping` when it answers as that process, as a
 * server asked to stop answers until it exits, `unresponsive` when the request timed out while the
 * registered process still runs, as when it is hung, suspended or too busy to answer, which `stop`
 * then signals. None when no registered server answers or runs.
 */
export const registered = (directory: string) =>
  Effect.gen(function* () {
    const registration = yield* readRegistration(directory);
    if (Option.isNone(registration)) return Option.none();
    const answer = yield* probe(registration.value);
    const status =
      answer.state === "ready" || answer.state === "starting" || answer.state === "stopping"
        ? answer.state
        : answer.state === "silent" &&
            answer.timedOut &&
            (yield* registeredServerRuns(directory, registration.value))
          ? ("unresponsive" as const)
          : undefined;
    return status === undefined
      ? Option.none()
      : Option.some({ ...running(registration.value), status });
  });

/**
 * The registered server if it is ready, without starting one. With `version`, only that release.
 */
export const discover = (directory: string, options: { readonly version?: string } = {}) =>
  registered(directory).pipe(
    Effect.map(
      Option.flatMap(({ status, ...service }): Option.Option<RunningService> =>
        status === "ready" && (options.version === undefined || service.version === options.version)
          ? Option.some(service)
          : Option.none(),
      ),
    ),
  );

/** Whether `pid` exits within about five seconds. */
const exits = (pid: number) =>
  processExists(pid).pipe(
    Effect.repeat({
      while: (alive) => alive,
      schedule: Schedule.spaced(timing.exitPoll).pipe(Schedule.upTo({ times: timing.exitPolls })),
    }),
    Effect.map((alive) => !alive),
  );

/**
 * Signal the server `registration` names. A server that leads its own process group, as a
 * background server does, is signalled with that group on POSIX, so the telemetry collector and
 * app runtimes it started end with it instead of running on against its data directory. A
 * foreground server shares its terminal's group, so only its process is signalled.
 */
const signal = (registration: ServiceRegistration, name: "SIGTERM" | "SIGKILL") => {
  const { pid } = registration;
  const one = Effect.try(() => process.kill(pid, name));
  return (
    registration.group === true && process.platform !== "win32"
      ? Effect.try(() => process.kill(-pid, name)).pipe(Effect.catch(() => one))
      : one
  ).pipe(Effect.ignore);
};

/** Ask the server to shut down; a server that does not answer is signalled instead. */
const requestStop = (registration: ServiceRegistration) =>
  HttpClient.execute(
    HttpClientRequest.post(`${registration.url}${serviceStopPath}`).pipe(
      HttpClientRequest.bearerToken(Redacted.make(registration.password)),
    ),
  ).pipe(
    Effect.timeout(timing.request),
    Effect.ignore,
    Effect.provide(NodeHttpClient.layerNodeHttp),
  );

/**
 * Stop the server `registration` names, then remove the registration if it still names it.
 * Escalation follows the process that was asked to stop, not the file, which a successor may
 * already have replaced. Only a process that proves it is the registered one is sent the password
 * in a stop request. One that times out, as a hung server does, is signalled without it. Each
 * signal, SIGTERM and then SIGKILL, goes only to a pid that `registeredProcess` finds still the
 * server's: on Linux and macOS one that runs on this boot with the start time the server
 * registered, on Windows one the data directory's lock names whose pipe is still open. Once no
 * process has the pid, or it is not the server's, the server has exited and escalation ends with
 * its registration removed. When that cannot be told, it is neither signalled nor forgotten:
 * stopping fails and the registration stays. One that is not there is waited for but never
 * signalled, and the password is not sent to whatever listens there.
 */
const terminate = (directory: string, registration: ServiceRegistration) =>
  Effect.gen(function* () {
    const current = yield* readRegistration(directory);
    if (Option.isNone(current) || !sameRegistration(current.value, registration)) return;
    const answer = yield* probe(registration);
    const { pid } = registration;
    /** Whether escalation ends with `name`: the server has exited, or exits after it. */
    const endsWith = (name: "SIGTERM" | "SIGKILL") =>
      Effect.gen(function* () {
        if (!(yield* processExists(pid))) return true;
        const state = yield* registeredProcess(directory, registration);
        if (state === "exited") return true;
        if (state !== "running") return false;
        yield* signal(registration, name);
        return yield* exits(pid);
      });
    if (absent(answer)) yield* exits(pid);
    else {
      const proven = answer.state !== "silent";
      if (proven) yield* requestStop(registration);
      if (
        (!proven || !(yield* exits(pid))) &&
        !(yield* endsWith("SIGTERM")) &&
        !(yield* endsWith("SIGKILL"))
      )
        return yield* new ServiceFailed({ reason: "stop-failed", detail: String(pid) });
    }
    yield* removeRegistration(directory, registration);
  });

/** Stop the registered background server, if any. */
export const stop = (directory: string) =>
  Effect.gen(function* () {
    const registration = yield* readRegistration(directory);
    if (Option.isSome(registration)) yield* terminate(directory, registration.value);
  });

/** Node options that change how the entry script loads, which a copy of this CLI needs too. */
const nodeOptions = (execArgv: ReadonlyArray<string>) =>
  execArgv.flatMap((option, index) => {
    if (index > 0 && execArgv[index - 1] === "--conditions") return [];
    if (option === "--conditions") {
      const value = execArgv[index + 1];
      return value === undefined ? [] : [option, value];
    }
    if (option.startsWith("--conditions=") || option.startsWith("--disable-warning="))
      return [option];
    return [
      "--experimental-ffi",
      "--use-system-ca",
      "--enable-source-maps",
      "--no-addons",
      "--no-warnings",
    ].includes(option)
      ? [option]
      : [];
  });

/**
 * The command that runs this CLI again. A release executable runs itself; Node or Bun runs the
 * entry script it started with.
 */
export const selfCommand = Effect.gen(function* () {
  const path = yield* Path.Path;
  const runtime = path.basename(process.execPath, path.extname(process.execPath)).toLowerCase();
  if (runtime !== "node" && runtime !== "nodejs" && runtime !== "bun")
    return [process.execPath] as const;
  const entry = process.argv[1];
  if (entry === undefined)
    return yield* new ServiceFailed({
      reason: "start-failed",
      detail: "Executor could not tell which script started it, so it cannot start a server.",
    });
  const script = path.resolve(entry);
  return runtime === "bun"
    ? ([process.execPath, script] as const)
    : ([process.execPath, ...nodeOptions(process.execArgv), script] as const);
});

/**
 * The environment a server this client starts runs with. EXECUTOR_API_KEY and
 * EXECUTOR_ENCRYPTION_KEY together supply a data directory's keys. One without the other is a
 * client's credential, which the client sends as its bearer; the server would refuse to start
 * with half a key pair, so neither is passed on.
 */
const serverEnvironment = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> => {
  if (env.EXECUTOR_API_KEY !== undefined && env.EXECUTOR_ENCRYPTION_KEY !== undefined)
    return { ...env };
  const { EXECUTOR_API_KEY: _apiKey, EXECUTOR_ENCRYPTION_KEY: _encryptionKey, ...rest } = env;
  return rest;
};

const startFailed = (detail: string, configuration?: LocalConfigurationReason) =>
  new ServiceFailed({
    reason: "start-failed",
    detail,
    ...(configuration === undefined ? {} : { configuration }),
  });

/** A failed server's output without its refusal line, and the reason that line gave. */
const refused = (output: string) => {
  const lines = output.split("\n");
  const reasons = lines.flatMap((line) =>
    Option.toArray(Schema.decodeUnknownOption(ServiceRefusal)(line.trim())),
  );
  const text = lines
    .filter((line) => Option.isNone(Schema.decodeUnknownOption(ServiceRefusal)(line.trim())))
    .join("\n")
    .trim();
  return { text, configuration: reasons[0]?.reason };
};

/** One detached start attempt and the end of what it wrote to stderr. */
interface Contender {
  readonly pid: number | undefined;
  /** The attempt exited, or could not start. */
  readonly finished: () => boolean;
  /** It exited with code 0, which a contender does when another server won. */
  readonly clean: () => boolean;
  readonly failure: () => ServiceFailed | undefined;
  /** Stop keeping its output, but keep draining it so the server never blocks on stderr. */
  readonly release: () => void;
  /** Ask the attempt to exit with SIGTERM, unless it already has. */
  readonly terminate: () => void;
  /** Completes once its process has exited, or could not start. */
  readonly exited: Effect.Effect<void>;
}

/**
 * Start one detached `serve --service`. Node's spawner is used directly because Effect's keeps a
 * piped stream referenced, which would hold this command open for as long as the server runs.
 * Here the child and its stderr are unreferenced: the command exits when its own work is done.
 */
const startContender = (
  command: ReadonlyArray<string>,
  directory: string,
  env: Readonly<Record<string, string | undefined>>,
) =>
  Effect.try({
    try: (): Contender => {
      const [executable = "", ...args] = command;
      const child = spawn(executable, args, {
        cwd: directory,
        env,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      const decoder = new TextDecoder();
      let output = "";
      let error: ServiceFailed | undefined;
      let closed = false;
      const exited = Deferred.makeUnsafe<void>();
      const keep = (chunk: Uint8Array) => {
        output = (output + decoder.decode(chunk, { stream: true })).slice(-stderrLimit);
      };
      child.stderr.on("data", keep);
      if ("unref" in child.stderr && typeof child.stderr.unref === "function") child.stderr.unref();
      child.once("error", (cause) => {
        error = startFailed(`Executor could not run ${executable}: ${cause.message}`);
        Deferred.doneUnsafe(exited, Effect.void);
      });
      child.once("exit", () => {
        Deferred.doneUnsafe(exited, Effect.void);
      });
      child.once("close", () => {
        closed = true;
      });
      child.unref();
      const ended = () =>
        child.exitCode !== null
          ? `exited with code ${child.exitCode}`
          : `ended by ${child.signalCode}`;
      return {
        pid: child.pid,
        finished: () => error !== undefined || closed,
        clean: () => child.exitCode === 0,
        failure: () => {
          if (error !== undefined) return error;
          if ((child.exitCode === null || child.exitCode === 0) && child.signalCode === null)
            return undefined;
          const { text, configuration } = refused(output);
          return startFailed(text === "" ? `The server ${ended()}.` : text, configuration);
        },
        release: () => {
          child.stderr.off("data", keep);
          child.stderr.resume();
          output = "";
        },
        // Node signals nothing once it has seen the child exit, so a reused pid is never hit.
        terminate: () => {
          child.kill("SIGTERM");
        },
        exited: Deferred.await(exited),
      };
    },
    catch: (cause) =>
      startFailed(`Executor could not start ${command[0] ?? "itself"}: ${String(cause)}`),
  });

/**
 * One `ensure` call's start attempts. At most two run at once: one candidate and one that
 * competes if the first stalls before taking the server lock. The first failure is kept, and no
 * replacement starts after it, so a crash is reported instead of retried until the deadline.
 */
const contenderPool = () => {
  const contenders = new Set<Contender>();
  let failure: ServiceFailed | undefined;
  let spawnDelay = timing.spawnDelay;
  let lastSpawn = 0;
  return {
    failure: () => failure,
    /** A registered server answered, so the next attempt waits the base delay again. */
    answered: () => {
      spawnDelay = timing.spawnDelay;
    },
    /** The server `pid` is being replaced: forget its attempt, finished ones and their failure. */
    evict: (pid: number) => {
      for (const contender of contenders)
        if (contender.pid === pid || contender.finished()) {
          contender.release();
          contenders.delete(contender);
        }
      failure = undefined;
      lastSpawn = 0;
    },
    /** Let the next attempt start without waiting. */
    recruitNow: (now: number) => {
      lastSpawn = now - spawnDelay;
    },
    /** Collect finished attempts; the kept failure once none is left running. */
    reap: () => {
      const finished = [...contenders].filter((contender) => contender.finished());
      failure ??= finished
        .map((contender) => contender.failure())
        .find((found) => found !== undefined);
      if (finished.some((contender) => contender.clean()))
        spawnDelay = Math.min(spawnDelay * 2, timing.maxSpawnDelay);
      for (const contender of finished) contenders.delete(contender);
      return contenders.size === 0 ? failure : undefined;
    },
    /** A registration that has not answered yet gets one spawn delay before an attempt competes. */
    shouldRecruit: (registered: boolean, now: number) => {
      if (lastSpawn === 0 && registered) lastSpawn = now;
      return failure === undefined && contenders.size < 2 && now - lastSpawn >= spawnDelay;
    },
    add: (contender: Contender, now: number) => {
      contenders.add(contender);
      lastSpawn = now;
    },
    /**
     * `ensure` is done with its attempts. Each one that is not the registered server `pid` is
     * still before or at listening, so it is asked to exit; left running, it could take the port
     * once that server stops and register as a background server no client asked for.
     */
    dismiss: (pid: number | undefined) => {
      for (const contender of contenders) {
        contender.release();
        if (contender.pid !== pid) contender.terminate();
      }
    },
  };
};

/** Why `ensure` is starting a server; `previous` is the version it replaces. */
export interface ServiceStart {
  readonly version: string;
  readonly previous?: string;
}

/** What a command says on stderr while it starts or replaces the background server. */
export const announceStart = (start: ServiceStart) =>
  Console.error(
    start.previous === undefined
      ? "Starting background Executor..."
      : `Restarting background Executor (running ${start.previous}, this is ${start.version})...`,
  );

/**
 * A ready background server for `directory`, started if needed. `replace` stops a server that runs
 * another version and starts this one; `ignore` uses whatever runs. A contender is never killed for
 * being slow; a registered server that times out three probes in a row is. Once this returns, every
 * contender it started that is not the registered server is asked to exit.
 */
export const ensure = (
  directory: string,
  options: {
    readonly version: "replace" | "ignore";
    readonly onStart?: (start: ServiceStart) => Effect.Effect<void>;
    /**
     * Runs as each start attempt begins, with its process ID and an effect that completes once it
     * has exited. A caller that may itself be ended before `ensure` is done, so `ensure` never asks
     * the attempts to exit, can use it to end them.
     */
    readonly onAttempt?: (attempt: {
      readonly pid: number;
      readonly exited: Effect.Effect<void>;
    }) => Effect.Effect<void>;
    /**
     * The program that runs `serve --service`, as `selfCommand` names it, and the version its
     * servers report. This CLI and its own version by default. `env`, when given, replaces this
     * process's environment as the one servers start with; the saved `env` setting and the data
     * directory still apply on top, and a lone EXECUTOR_API_KEY or EXECUTOR_ENCRYPTION_KEY is
     * still left out.
     */
    readonly program?: {
      readonly command: ReadonlyArray<string>;
      readonly version: string;
      readonly env?: Readonly<Record<string, string | undefined>>;
    };
  },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const version = options.program?.version ?? (yield* serviceVersion);
    const onStart = options.onStart ?? announceStart;
    const pool = contenderPool();
    let timeouts:
      | { readonly registration: ServiceRegistration; readonly count: number }
      | undefined;
    let announced = false;
    const announce = (previous?: string) =>
      Effect.suspend(() => {
        if (announced) return Effect.void;
        announced = true;
        return onStart(previous === undefined ? { version } : { version, previous });
      });
    const recruit = Effect.gen(function* () {
      const settings = yield* readSettings(directory);
      const env = serverEnvironment({
        ...(options.program?.env ?? process.env),
        ...settings.env,
        EXECUTOR_DATA_DIR: directory,
      });
      // The server refuses an invalid key storage setting before it creates anything, so it is
      // checked here first, before the data directory is created for it to start in.
      yield* keyStorageConfig.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
        Effect.mapError(() => startFailed(keyStorageInvalid, "misconfigured")),
      );
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      const command = options.program?.command ?? (yield* selfCommand);
      return yield* startContender([...command, "serve", "--service"], directory, env);
    });

    const attempt = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const found = yield* readRegistration(directory);
      const answer = Option.isSome(found) ? yield* probe(found.value) : silent(false);
      // A registered process that has exited, as after a crash, no longer answers: forget its
      // registration and start a server at once, also when its pid now names another program or
      // it ran on another boot. One that may still run gets a spawn delay to finish stopping.
      const stale =
        Option.isSome(found) &&
        absent(answer) &&
        !(yield* registeredServerRuns(directory, found.value));
      if (stale) yield* removeRegistration(directory, found.value);
      const registration = stale ? Option.none<ServiceRegistration>() : found;
      if (Option.isSome(registration) && answer.state === "silent" && answer.timedOut) {
        const count =
          timeouts !== undefined && sameRegistration(timeouts.registration, registration.value)
            ? timeouts.count + 1
            : 1;
        timeouts = { registration: registration.value, count };
        if (count >= hungAfter) {
          yield* announce();
          yield* terminate(directory, registration.value);
          pool.evict(registration.value.pid);
          pool.recruitNow(now);
          timeouts = undefined;
        }
      } else timeouts = undefined;

      if (Option.isSome(registration) && answer.state !== "silent") {
        pool.answered();
        // A server that was asked to stop is going away, so it is waited for, not stopped or
        // joined; one starts once its registration is gone.
        if (answer.state === "stopping") return Option.none<RunningService>();
        if (options.version === "replace" && registration.value.version !== version) {
          yield* announce(registration.value.version);
          yield* stop(directory).pipe(Effect.ignore);
          pool.evict(registration.value.pid);
          return Option.none<RunningService>();
        }
        if (answer.state === "incompatible")
          return yield* startFailed(
            `${registration.value.url} does not answer as an Executor server for ${directory}. Run \`executor service restart\` to replace it.`,
          );
        return answer.state === "ready"
          ? Option.some(running(registration.value))
          : Option.none<RunningService>();
      }

      const failed = pool.reap();
      if (failed !== undefined) return yield* failed;
      if (pool.shouldRecruit(Option.isSome(registration), now)) {
        // An Executor from before the background service holds no lock; another server would
        // open its databases too.
        yield* refuseEarlierServer(directory);
        yield* announce();
        const contender = yield* recruit;
        pool.add(contender, now);
        if (contender.pid !== undefined && options.onAttempt !== undefined)
          yield* options.onAttempt({ pid: contender.pid, exited: contender.exited });
      }
      return Option.none<RunningService>();
    });

    const found = yield* attempt.pipe(
      Effect.repeat({
        until: Option.isSome,
        schedule: Schedule.spaced(timing.poll).pipe(Schedule.upTo({ duration: timing.deadline })),
      }),
      // The server found keeps running, or else whichever one registered meanwhile.
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const server =
            Exit.isSuccess(exit) && Option.isSome(exit.value)
              ? exit.value.value.pid
              : Option.getOrUndefined(yield* readRegistration(directory))?.pid;
          yield* Effect.sync(() => pool.dismiss(server));
        }),
      ),
    );
    if (Option.isNone(found))
      return yield* pool.failure() ?? new ServiceFailed({ reason: "start-timeout", detail: "" });
    return found.value;
  });

/** The readiness line a `serve --stdio` child prints on stdout. */
const StandaloneReady = Schema.fromJsonString(
  Schema.Struct({ url: Schema.String, browserOrigin: Schema.optional(Schema.String) }),
);
/** How long a private server gets to stop once its stdin closes, before it is killed. */
const standaloneStop = Duration.seconds(5);

/** This command's private server did not start; `detail` is what it said, if anything. */
const privateFailed = (detail: string, configuration?: LocalConfigurationReason) =>
  new ServiceFailed({
    reason: "start-failed",
    detail,
    standalone: true,
    ...(configuration === undefined ? {} : { configuration }),
  });

/**
 * A private server for this command's scope: `serve --stdio` on a free port, with a password
 * only this process knows. The child stops when its stdin closes, so it ends with this process
 * even if the scope never closes. When the scope closes, its stdin is closed first and it gets a
 * few seconds to stop before it is killed, which on Windows ends it without any cleanup. Its
 * stderr is kept until it is ready, so a failure states the child's own reason, and passed through
 * from then on. `exited` fails once the child stops on its own, saying how it ended.
 */
export const standalone = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const [executable, ...args] = yield* selfCommand.pipe(
    Effect.mapError((error) => privateFailed(error.detail)),
  );
  const password = yield* Effect.sync(() =>
    Redacted.make(Hex.encode(crypto.getRandomValues(new Uint8Array(32)))),
  );
  const closing = yield* Deferred.make<void>();
  const child = yield* spawner
    .spawn(
      ChildProcess.make(executable, [...args, "serve", "--stdio"], {
        env: serverEnvironment({
          ...process.env,
          EXECUTOR_PORT: "0",
          [servicePasswordVariable]: Redacted.value(password),
        }),
        extendEnv: false,
        // Nothing is written; the stream ends, closing the child's stdin, once `closing` completes.
        stdin: Stream.fromEffectDrain(Deferred.await(closing)),
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGTERM",
        forceKillAfter: "3 seconds",
      }),
    )
    .pipe(
      Effect.mapError((cause) =>
        privateFailed(`Executor could not start ${executable}: ${cause.message}`),
      ),
    );
  const ready = yield* Deferred.make<typeof StandaloneReady.Type, ServiceFailed>();
  // What the child wrote on stderr while it started; none once it is ready and passed through.
  const held = yield* Ref.make(Option.some(""));
  const show = (text: string) => (text === "" ? Effect.void : Console.error(text));
  const stderr = yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      Ref.modify(held, (kept) =>
        Option.isSome(kept)
          ? [Effect.void, Option.some(`${kept.value}${line}\n`.slice(-stderrLimit))]
          : [Console.error(line), kept],
      ).pipe(Effect.flatten),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );
  // Keep reading stdout after readiness so a later write never fails with EPIPE.
  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      Option.match(Schema.decodeUnknownOption(StandaloneReady)(line), {
        onNone: () => Effect.void,
        onSome: (line) =>
          Ref.getAndSet(held, Option.none()).pipe(
            Effect.flatMap((kept) => show(Option.getOrElse(kept, () => "").trimEnd())),
            Effect.andThen(Deferred.succeed(ready, line)),
          ),
      }),
    ),
    Effect.ignore,
    // Once stdout ends, the rest of stderr follows within moments.
    Effect.ensuring(
      Fiber.join(stderr).pipe(
        Effect.timeout("2 seconds"),
        Effect.ignore,
        Effect.andThen(Ref.get(held)),
        Effect.flatMap((kept) => {
          const { text, configuration } = refused(Option.getOrElse(kept, () => ""));
          return Deferred.fail(
            ready,
            privateFailed(text === "" ? "It exited before it was ready." : text, configuration),
          );
        }),
      ),
    ),
    Effect.forkScoped,
  );
  // Registered last, so it runs first: the readers above still drain the child while it stops.
  yield* Effect.addFinalizer(() =>
    Deferred.succeed(closing, undefined).pipe(
      Effect.andThen(child.exitCode.pipe(Effect.timeout(standaloneStop), Effect.ignore)),
    ),
  );
  const { url, browserOrigin } = yield* Deferred.await(ready);
  const exited = child.exitCode.pipe(
    Effect.map((code) => `exit code ${code}`),
    Effect.orElseSucceed(() => "ended by a signal"),
    Effect.flatMap((detail) => Effect.fail(new ServiceFailed({ reason: "exited", detail }))),
  );
  return {
    url,
    password,
    ...(browserOrigin === undefined ? {} : { browserOrigin }),
    exited,
  };
});
