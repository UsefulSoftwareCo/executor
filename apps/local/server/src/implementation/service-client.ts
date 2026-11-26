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
  poll: Duration.millis(25),
  request: Duration.seconds(2),
  spawnDelay: 5_000,
  maxSpawnDelay: 30_000,
  deadline: Duration.minutes(2),
  exitPoll: Duration.millis(50),
  exitPolls: 100,
};
const hungAfter = 3;
const stderrLimit = 8 * 1024;

export interface RunningService {
  readonly url: string;
  readonly version: string;
  readonly pid: number;
  readonly password: Redacted.Redacted<string>;
  readonly browserOrigin?: string | undefined;
}

const running = (registration: ServiceRegistration): RunningService => ({
  url: registration.url,
  version: registration.version,
  pid: registration.pid,
  password: Redacted.make(registration.password),
  browserOrigin: registration.browserOrigin,
});

type Answer =
  | { readonly state: "ready" | "starting" | "stopping" | "incompatible" }
  | { readonly state: "silent"; readonly timedOut: boolean };

const silent = (timedOut: boolean): Answer => ({ state: "silent", timedOut });

const absent = (answer: Answer) =>
  answer.state === "incompatible" || (answer.state === "silent" && !answer.timedOut);

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
    if (!(yield* answersAs(registration, info.value, challenge))) return silent(false);
    return { state: info.value.status } satisfies Answer;
  }).pipe(
    Effect.timeout(timing.request),
    Effect.catchTag("TimeoutError", () => Effect.succeed(silent(true))),
    Effect.catchTag("HttpClientError", () => Effect.succeed(silent(false))),
    Effect.provide(NodeHttpClient.layerNodeHttp),
  );

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

const exits = (pid: number) =>
  processExists(pid).pipe(
    Effect.repeat({
      while: (alive) => alive,
      schedule: Schedule.spaced(timing.exitPoll).pipe(Schedule.upTo({ times: timing.exitPolls })),
    }),
    Effect.map((alive) => !alive),
  );

const signal = (registration: ServiceRegistration, name: "SIGTERM" | "SIGKILL") => {
  const { pid } = registration;
  const one = Effect.try(() => process.kill(pid, name));
  return (
    registration.group === true && process.platform !== "win32"
      ? Effect.try(() => process.kill(-pid, name)).pipe(Effect.catch(() => one))
      : one
  ).pipe(Effect.ignore);
};

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

const terminate = (directory: string, registration: ServiceRegistration) =>
  Effect.gen(function* () {
    const current = yield* readRegistration(directory);
    if (Option.isNone(current) || !sameRegistration(current.value, registration)) return;
    const answer = yield* probe(registration);
    const { pid } = registration;
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

export const stop = (directory: string) =>
  Effect.gen(function* () {
    const registration = yield* readRegistration(directory);
    if (Option.isSome(registration)) yield* terminate(directory, registration.value);
  });

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

interface Contender {
  readonly pid: number | undefined;
  readonly finished: () => boolean;
  readonly clean: () => boolean;
  readonly failure: () => ServiceFailed | undefined;
  readonly release: () => void;
  readonly terminate: () => void;
  readonly exited: Effect.Effect<void>;
}

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
        terminate: () => {
          child.kill("SIGTERM");
        },
        exited: Deferred.await(exited),
      };
    },
    catch: (cause) =>
      startFailed(`Executor could not start ${command[0] ?? "itself"}: ${String(cause)}`),
  });

const contenderPool = () => {
  const contenders = new Set<Contender>();
  let failure: ServiceFailed | undefined;
  let spawnDelay = timing.spawnDelay;
  let lastSpawn = 0;
  return {
    failure: () => failure,
    answered: () => {
      spawnDelay = timing.spawnDelay;
    },
    evict: (pid: number) => {
      for (const contender of contenders)
        if (contender.pid === pid || contender.finished()) {
          contender.release();
          contenders.delete(contender);
        }
      failure = undefined;
      lastSpawn = 0;
    },
    recruitNow: (now: number) => {
      lastSpawn = now - spawnDelay;
    },
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
    shouldRecruit: (registered: boolean, now: number) => {
      if (lastSpawn === 0 && registered) lastSpawn = now;
      return failure === undefined && contenders.size < 2 && now - lastSpawn >= spawnDelay;
    },
    add: (contender: Contender, now: number) => {
      contenders.add(contender);
      lastSpawn = now;
    },
    dismiss: (pid: number | undefined) => {
      for (const contender of contenders) {
        contender.release();
        if (contender.pid !== pid) contender.terminate();
      }
    },
  };
};

export interface ServiceStart {
  readonly version: string;
  readonly previous?: string;
}

export const announceStart = (start: ServiceStart) =>
  Console.error(
    start.previous === undefined
      ? "Starting background Executor..."
      : `Restarting background Executor (running ${start.previous}, this is ${start.version})...`,
  );

export const ensure = (
  directory: string,
  options: {
    readonly version: "replace" | "ignore";
    readonly onStart?: (start: ServiceStart) => Effect.Effect<void>;
    readonly onAttempt?: (attempt: {
      readonly pid: number;
      readonly exited: Effect.Effect<void>;
    }) => Effect.Effect<void>;
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

const StandaloneReady = Schema.fromJsonString(
  Schema.Struct({ url: Schema.String, browserOrigin: Schema.optional(Schema.String) }),
);
const standaloneStop = Duration.seconds(5);

const privateFailed = (detail: string, configuration?: LocalConfigurationReason) =>
  new ServiceFailed({
    reason: "start-failed",
    detail,
    standalone: true,
    ...(configuration === undefined ? {} : { configuration }),
  });

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
