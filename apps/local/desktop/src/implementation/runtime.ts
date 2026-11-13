/**
 * The program the desktop runs the background Executor with, and how it starts it. A packaged app
 * copies the runtime it bundles out of the app first: the server outlives the app, while an
 * installer replaces the app's files and an AppImage unmounts them. Development runs the CLI from
 * source, as `bun run executor`.
 */
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

/**
 * `command` is `[executable, ...arguments]` that runs the CLI; a command such as `serve --service`
 * follows. `version` is what its servers report, which decides whether a running one is replaced.
 * `env` is the whole environment it runs with.
 */
export interface ServiceProgram {
  readonly command: ReadonlyArray<string>;
  readonly version: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface ServiceRuntime {
  readonly program: Effect.Effect<ServiceProgram, DesktopFailed>;
  /**
   * Remove staged runtimes other than this one, except those of `version`, which the running
   * background server may use. One that cannot be removed yet is tried again next launch.
   */
  readonly clean: (version: string) => Effect.Effect<void>;
}

/** What an AppImage's runtime sets for the app it runs: its mount, its file and how it started. */
const appImageVariables = ["APPDIR", "APPIMAGE", "ARGV0", "OWD"];

/**
 * The environment a background server runs with: this process's, without what belongs to this app
 * process only. A server outlives the app. An AppImage's AppRun puts its mount first in PATH,
 * LD_LIBRARY_PATH, XDG_DATA_DIRS and GSETTINGS_SCHEMA_DIR, and once the app quits the mount is
 * removed and any local user may create that path in /tmp, so no entry may name it. Electron's own
 * variables change how Electron and Node children behave.
 */
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

/**
 * Bash closes every descriptor above stderr, then replaces itself with the command, which keeps
 * its process ID. Descriptor numbers above 9 need Bash; POSIX `sh` may not accept them.
 */
const closeInherited = `for fd in /proc/$$/fd/*; do fd=\${fd##*/}; [ "$fd" -gt 2 ] && eval "exec $fd>&-"; done; exec "$@"`;

/**
 * `command`, started with as few of its starter's descriptors as the platform allows. A background
 * server outlives the desktop, so anything of the app it inherits stays open after the app quits.
 *
 * The desktop starts it from a utility process (see `ensureServer`). On Windows a child inherits
 * every inheritable handle of its parent. Electron's main process keeps its standard streams
 * inheritable, while Chromium starts the utility process with only the handles it names and Node
 * there makes its standard streams non-inheritable. One handle is still inherited: Chromium creates
 * the utility process's end of its channel to the main process inheritable, so a server holds that
 * end for as long as it runs. It is no stream or file of the app, and Electron still reports the
 * utility process's exit, also one ended from outside, while a server holds it (see
 * `starterDeadline`). On Linux a child inherits every descriptor without close-on-exec, and the
 * utility process still holds some from Chromium that Node leaves open across exec, such as
 * Electron's V8 snapshot, which in an AppImage keeps its mount in use. So there Bash closes every
 * descriptor above stderr first. Without /bin/bash the command starts as it is and keeps them, and
 * an AppImage's mount stays in use while the server runs. The utility process's channel to the main
 * process is close-on-exec on Linux, so a server never holds it there. macOS starts each child with
 * only the descriptors it names.
 */
const withoutInherited = (command: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (process.platform !== "linux" || !(yield* fs.exists("/bin/bash"))) return command;
    return ["/bin/bash", "-c", closeInherited, "executor", ...command];
  });

/**
 * `bin.ts` runs under the Node on PATH. Its environment is this one, which carries the dev defaults
 * and EXECUTOR_BUILD_VERSION, so it reports the version this process reads.
 */
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

/** The build `file` in `directory` names: `desktop-runtime.json` unless another file is given. */
const readBuild = (directory: string, file = desktopRuntimeBuildFile) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs
      .readFileString(path.join(directory, file))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(BuildJson)));
  });

/**
 * Written into a staged runtime last, after every file and the rename into place, naming its build.
 * A staged directory without it is partial, as after a removal that stopped partway, and is never
 * used; removing a staged runtime removes it first.
 */
const stagedFile = ".staged.json";

const hasCode = (...codes: [string, ...Array<string>]) =>
  Schema.is(Schema.Struct({ cause: Schema.Struct({ code: Schema.Literals(codes) }) }));

/**
 * Antivirus scanners and the indexer on Windows briefly hold files just written, so renaming or
 * removing their directory fails with EPERM, EBUSY or EACCES for a moment, which graceful-fs also
 * retries. A process that was just ended keeps its files open for a moment after it is gone too,
 * about a third of a second after its tree is killed, so a data directory whose server just stopped
 * or was killed cannot be renamed yet. There such a step is tried again for a few seconds before it
 * fails. The data migration and a reset rename data directories the same way.
 */
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

/**
 * Stage `source`, the app's bundled runtime, as `<staging>/<version>-<build>` once per build. The
 * copy goes to a temporary directory first, is renamed into place and is then marked staged, so a
 * staged runtime is used only once it is complete.
 */
export const packagedRuntime = (options: { readonly source: string; readonly staging: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    /** Remove a staged runtime, its mark first, so a removal that stops partway is staged again. */
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
        // A partial copy is renamed aside under a name `clean` removes, so it is never used.
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
          // Another launch may have staged the same build meanwhile; only whole copies move in.
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
      // `bin.mjs` reports the release it was built as, whatever this process's environment says.
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
    // Staged once per launch; a failure is tried again by the next connection attempt.
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

/** The server starter's entry, which `scripts/build.mjs` bundles beside the main entry. */
const starterEntry = "starter.cjs";
/** How long a starter gets to end the start attempts it began and exit before it is killed. */
const starterStop = Duration.seconds(5);
/**
 * How long a starter gets to report whether the server started. `ensure` gives up after two
 * minutes of attempts, and its last probe and stop take seconds more. One that has reported
 * neither by then has hung: Electron reports a starter that exits, also on Windows, where a server
 * it started holds its end of its channel to this process (see `withoutInherited`).
 */
const starterDeadline = Duration.minutes(3);
/** How much of a starter's stderr is kept for the log. */
const starterOutputLimit = 8 * 1024;

/** States in Linux's `/proc/<pid>/stat` of a process that has exited: a zombie, or one being reaped. */
const exitedStates = new Set(["Z", "X", "x"]);

/**
 * Whether `pid` still runs, stopped or hung included. Signal 0 also reaches a process that has
 * exited and has not been reaped yet, a zombie, so on Linux its state in `/proc` decides. macOS has
 * no such file. There Electron reports a starter's exit as soon as it exits, and a starter is
 * checked here only when Electron has reported no exit; that leaves a starter that exits just
 * before the check. On Windows signal 0 reports an exited process as gone.
 */
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
    // The state follows the command name, which is in parentheses and may contain any character.
    const state = stat.value.charAt(stat.value.lastIndexOf(")") + 2);
    return state !== "" && !exitedStates.has(state);
  });

/**
 * End the start attempts in `pids` that a starter began and has not reported exited, except the
 * server registered for `directory`, as `ensure` asks them to exit once it is done. That is done
 * only while the starter still runs: it is each attempt's parent, so an attempt's ID cannot name
 * another process before the starter has seen the attempt exit, and the starter reports each exit
 * it sees. The one gap is an attempt the starter saw exit just before it stopped answering, whose
 * report has not arrived: its ID is free and may already name another process. Once the starter
 * has exited, zombie included, nothing holds its attempts' IDs, and an attempt that exits frees its
 * ID at once; the attempts are left to finish, as the server or by exiting once another one serves.
 */
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
      // A detached attempt leads its own process group on POSIX, with the processes it started.
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

/**
 * A ready background server for `directory`, started if needed, as the CLI's `ensure` returns it.
 * The desktop runs `ensure` in a server starter, an Electron utility process (see `starter.ts`), so
 * the detached server it starts inherits none of this process's handles. The starter ends with the
 * attempt: when this returns, fails or is interrupted, it is told to stop, which interrupts an
 * unfinished `ensure`, and it is killed if it has not exited within a few seconds. A starter that
 * reports no outcome within `starterDeadline` fails the start.
 */
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
    /** The start attempts the starter began and has not reported exited. */
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
        // V8 cannot continue in the starter, which exits next. Like any `error` event, one without
        // a listener would throw in this process.
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
          // Reports it sent before it exited are still read first.
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
            // It never asked the start attempts it began to exit. They end first, if it still runs.
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
