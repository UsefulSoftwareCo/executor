import { utilityProcess } from "electron";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Queue,
  Ref,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import { ServiceFailed } from "../../../server/src/contracts/service.ts";
import type {
  RunningService,
  ServiceStart,
} from "../../../server/src/implementation/service-client.ts";
import {
  readRegistration,
  serviceVersion,
} from "../../../server/src/implementation/service-files.ts";
import {
  DesktopFailed,
  DesktopRuntimeBuild,
  desktopRuntimeBuildFile,
  StarterAttempt,
  StarterCommand,
  StarterReport,
} from "../contracts/desktop.ts";

export interface ServiceProgram {
  readonly command: ReadonlyArray<string>;
  readonly version: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface ServiceRuntime {
  readonly program: Effect.Effect<ServiceProgram, DesktopFailed>;
  readonly clean: (version: string) => Effect.Effect<void>;
}

const appImageVariables = ["APPDIR", "APPIMAGE", "ARGV0", "OWD"];

const serverEnvironment = (environment: NodeJS.ProcessEnv) => {
  const mount = environment.APPDIR?.replace(/\/+$/u, "");
  const inMount = (entry: string) =>
    mount !== undefined && mount !== "" && (entry === mount || entry.startsWith(`${mount}/`));
  return Object.fromEntries(
    Object.entries(environment).flatMap(([name, value]): Array<[string, string]> => {
      if (value === undefined || name.startsWith("ELECTRON_")) return [];
      if (mount !== undefined && appImageVariables.includes(name)) return [];
      if (!value.split(":").some(inMount)) return [[name, value]];
      const kept = value.split(":").filter((entry) => !inMount(entry));
      return kept.length === 0 ? [] : [[name, kept.join(":")]];
    }),
  );
};

const closeInherited = `for fd in /proc/$$/fd/*; do fd=\${fd##*/}; [ "$fd" -gt 2 ] && eval "exec $fd>&-"; done; exec "$@"`;

const withoutInherited = (command: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (process.platform !== "linux" || !(yield* fs.exists("/bin/bash"))) return command;
    return ["/bin/bash", "-c", closeInherited, "executor", ...command];
  });

export const developmentRuntime = (root: string) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<FileSystem.FileSystem>();
    return {
      program: Effect.gen(function* () {
        const version = yield* serviceVersion;
        const command = yield* withoutInherited(["node", `${root}/apps/local/server/src/bin.ts`]);
        return { command, version, env: serverEnvironment(process.env) };
      }).pipe(
        Effect.provideContext(services),
        Effect.mapError(() => new DesktopFailed({ stage: "runtime" })),
      ),
      clean: () => Effect.void,
    } satisfies ServiceRuntime;
  });

const BuildJson = Schema.fromJsonString(DesktopRuntimeBuild);

const readBuild = (directory: string, file = desktopRuntimeBuildFile) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs
      .readFileString(path.join(directory, file))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(BuildJson)));
  });

const stagedFile = ".staged.json";

const hasCode = (...codes: [string, ...Array<string>]) =>
  Schema.is(Schema.Struct({ cause: Schema.Struct({ code: Schema.Literals(codes) }) }));

export const whileHeld = <A, E, R>(step: Effect.Effect<A, E, R>) =>
  process.platform === "win32"
    ? step.pipe(
        Effect.retry({
          while: hasCode("EPERM", "EBUSY", "EACCES"),
          schedule: Schedule.exponential("50 millis").pipe(
            Schedule.upTo({ duration: "5 seconds" }),
          ),
        }),
      )
    : step;

export const packagedRuntime = (options: { readonly source: string; readonly staging: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const remove = (directory: string) =>
      whileHeld(fs.remove(path.join(directory, stagedFile), { force: true })).pipe(
        Effect.andThen(whileHeld(fs.remove(directory, { recursive: true }))),
      );
    const stage = Effect.gen(function* () {
      const build = yield* readBuild(options.source);
      const name = `${build.version.replace(/[^a-zA-Z0-9._-]/gu, "-")}-${build.build}`;
      const target = path.join(options.staging, name);
      const marked = yield* readBuild(target, stagedFile).pipe(Effect.option);
      if (
        Option.isNone(marked) ||
        marked.value.version !== build.version ||
        marked.value.build !== build.build
      ) {
        yield* Effect.logInfo("Staging the Executor runtime").pipe(
          Effect.annotateLogs({ path: target }),
        );
        yield* fs.makeDirectory(options.staging, { recursive: true, mode: 0o700 });
        if (yield* fs.exists(target)) {
          const aside = path.join(options.staging, `.staging-${name}-${crypto.randomUUID()}`);
          yield* whileHeld(fs.rename(target, aside));
          yield* remove(aside).pipe(
            Effect.catch(() =>
              Effect.logWarning("Could not remove a partial Executor runtime yet").pipe(
                Effect.annotateLogs({ path: aside }),
              ),
            ),
          );
        }
        const temporary = yield* fs.makeTempDirectory({
          directory: options.staging,
          prefix: ".staging-",
        });
        yield* fs.copy(options.source, temporary, { overwrite: true });
        yield* whileHeld(fs.rename(temporary, target)).pipe(
          Effect.catch((error) =>
            fs
              .exists(target)
              .pipe(
                Effect.flatMap((staged) =>
                  remove(temporary).pipe(
                    Effect.ignore,
                    Effect.andThen(staged ? Effect.void : Effect.fail(error)),
                  ),
                ),
              ),
          ),
        );
        yield* fs.writeFileString(
          path.join(target, stagedFile),
          yield* Schema.encodeEffect(BuildJson)(build),
        );
      }
      const node = path.join(target, "node", process.platform === "win32" ? "node.exe" : "node");
      const program: ServiceProgram = {
        command: yield* withoutInherited([node, path.join(target, "bin.mjs")]),
        version: build.version,
        env: serverEnvironment(process.env),
      };
      return { name, program };
    }).pipe(
      Effect.provideContext(services),
      Effect.tapCause((cause) => Effect.logError("Could not stage the Executor runtime", cause)),
      Effect.mapError(() => new DesktopFailed({ stage: "runtime" })),
    );
    const lock = yield* Semaphore.make(1);
    const done = yield* Ref.make(Option.none<Effect.Success<typeof stage>>());
    const staged = lock.withPermit(
      Effect.gen(function* () {
        const found = yield* Ref.get(done);
        if (Option.isSome(found)) return found.value;
        const result = yield* stage;
        yield* Ref.set(done, Option.some(result));
        return result;
      }),
    );
    const clean = (version: string) =>
      Effect.gen(function* () {
        const { name } = yield* staged;
        for (const entry of yield* fs.readDirectory(options.staging)) {
          if (entry === name) continue;
          const directory = path.join(options.staging, entry);
          const build = entry.startsWith(".staging-")
            ? Option.none<DesktopRuntimeBuild>()
            : yield* readBuild(directory).pipe(Effect.option);
          if (Option.isSome(build) && build.value.version === version) continue;
          yield* remove(directory).pipe(
            Effect.tap(() =>
              Effect.logInfo("Removed an old Executor runtime").pipe(
                Effect.annotateLogs({ path: directory }),
              ),
            ),
            Effect.catch(() =>
              Effect.logWarning("Could not remove an old Executor runtime yet").pipe(
                Effect.annotateLogs({ path: directory }),
              ),
            ),
          );
        }
      }).pipe(Effect.provideContext(services), Effect.ignore);
    return {
      program: Effect.map(staged, ({ program }) => program),
      clean,
    } satisfies ServiceRuntime;
  });

const starterEntry = "starter.cjs";
const starterStop = Duration.seconds(5);
const starterDeadline = Duration.minutes(3);
const starterOutputLimit = 8 * 1024;

const exitedStates = new Set(["Z", "X", "x"]);

const stillRuns = (pid: number) =>
  Effect.gen(function* () {
    const exists = yield* Effect.try(() => process.kill(pid, 0)).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!exists || process.platform !== "linux") return exists;
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.readFileString(`/proc/${pid}/stat`).pipe(Effect.option);
    if (Option.isNone(stat)) return false;
    const state = stat.value.charAt(stat.value.lastIndexOf(")") + 2);
    return state !== "" && !exitedStates.has(state);
  });

const endAttempts = (directory: string, starter: number | undefined, pids: ReadonlySet<number>) =>
  Effect.gen(function* () {
    if (pids.size === 0) return;
    const running = starter !== undefined && (yield* stillRuns(starter));
    if (!running)
      return yield* Effect.logWarning(
        "Executor's server starter is gone; its start attempts are left to finish",
      ).pipe(Effect.annotateLogs({ pids: [...pids] }));
    const server = Option.getOrUndefined(yield* readRegistration(directory))?.pid;
    for (const pid of pids) {
      if (pid === server) continue;
      const ended = yield* Effect.try(() =>
        process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM"),
      ).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (ended)
        yield* Effect.logWarning(
          "Ended a start attempt of a server starter that did not exit",
        ).pipe(Effect.annotateLogs({ pid }));
    }
  });

export const ensureServer = (
  directory: string,
  options: {
    readonly version: "replace" | "ignore";
    readonly program: ServiceProgram;
    readonly onStart: (start: ServiceStart) => Effect.Effect<void>;
  },
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const reports = yield* Queue.unbounded<unknown, ServiceFailed>();
    const exited = yield* Deferred.make<number>();
    let output = "";
    let fatal: { readonly type: string; readonly location: string } | undefined;
    const attempts = new Set<number>();
    const starter = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const child = utilityProcess.fork(path.join(__dirname, starterEntry), [], {
          serviceName: "Executor server starter",
          stdio: ["ignore", "ignore", "pipe"],
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-starterOutputLimit);
        });
        child.on("message", (message: unknown) => {
          const attempt = Schema.decodeUnknownOption(StarterAttempt)(message);
          if (Option.isNone(attempt)) {
            Queue.offerUnsafe(reports, message);
            return;
          }
          StarterAttempt.match(attempt.value, {
            AttemptStarted: ({ pid }) => {
              attempts.add(pid);
            },
            AttemptExited: ({ pid }) => {
              attempts.delete(pid);
            },
          });
        });
        child.on("error", (type, location) => {
          fatal = { type, location };
          Queue.failCauseUnsafe(
            reports,
            Cause.fail(
              new ServiceFailed({
                reason: "start-failed",
                detail: `Executor's server starter stopped with a fatal error (${type}) before the server was ready.`,
              }),
            ),
          );
        });
        child.once("exit", (code) => {
          Deferred.doneUnsafe(exited, Exit.succeed(code));
          Queue.failCauseUnsafe(
            reports,
            Cause.fail(
              new ServiceFailed({
                reason: "start-failed",
                detail: `Executor's server starter exited with code ${code} before the server was ready.`,
              }),
            ),
          );
        });
        return child;
      }),
      (child) =>
        Effect.gen(function* () {
          if (!Deferred.isDoneUnsafe(exited))
            child.postMessage(
              yield* Schema.encodeEffect(StarterCommand)(StarterCommand.cases.Stop.make({})),
            );
          const code = yield* Deferred.await(exited).pipe(Effect.timeoutOption(starterStop));
          if (Option.isNone(code)) {
            yield* Effect.logWarning("Executor's server starter did not exit; stopping it");
            yield* endAttempts(directory, child.pid, attempts);
            child.kill();
          }
          if (fatal !== undefined)
            yield* Effect.logWarning("Executor's server starter stopped with a fatal error").pipe(
              Effect.annotateLogs(fatal),
            );
          if (output.trim() !== "")
            yield* Effect.logWarning("Executor's server starter wrote to stderr").pipe(
              Effect.annotateLogs({ output }),
            );
        }).pipe(Effect.orDie),
    );
    starter.postMessage(
      yield* Schema.encodeEffect(StarterCommand)(
        StarterCommand.cases.Start.make({
          directory,
          version: options.version,
          program: options.program,
        }),
      ).pipe(Effect.orDie),
    );
    const outcome = Effect.gen(function* () {
      while (true) {
        const report = yield* Queue.take(reports).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(StarterReport)),
          Effect.catchTag("SchemaError", () =>
            Effect.fail(
              new ServiceFailed({
                reason: "start-failed",
                detail: "Executor's server starter sent a report this desktop cannot read.",
              }),
            ),
          ),
        );
        const service = yield* StarterReport.match(report, {
          Starting: (start) =>
            options.onStart(start).pipe(Effect.as(Option.none<RunningService>())),
          Ready: ({ url, version, pid, password, browserOrigin }) =>
            Effect.succeed(
              Option.some<RunningService>({ url, version, pid, password, browserOrigin }),
            ),
          Failed: ({ error }) => Effect.fail(error),
        });
        if (Option.isSome(service)) return service.value;
      }
    });
    return yield* outcome.pipe(
      Effect.timeoutOrElse({
        duration: starterDeadline,
        orElse: () =>
          Effect.fail(
            new ServiceFailed({
              reason: "start-failed",
              detail: `Executor's server starter did not say whether the server started within ${Duration.toMinutes(starterDeadline)} minutes.`,
            }),
          ),
      }),
    );
  }).pipe(Effect.scoped);
