/**
 * Which process a pid names, exactly. Once a process exits, the operating system may give its pid
 * to another program, so a record that must name one process says more than its pid.
 *
 * On Linux and macOS a record holds the start time the operating system keeps for the process and
 * the boot that time belongs to. Every process is looked up the same way, this one included, so a
 * process's own record equals what another process reads for it, and two records are compared only
 * for equality.
 *
 * Windows keeps a start time too, but Node and Bun read another process's only by starting a
 * program such as PowerShell, which takes seconds on a busy machine, longer than a check can wait.
 * There a process that must be recognised listens on a named pipe for as long as it may be checked
 * (`holdPipe`), and its record names the pipe. Windows removes a pipe once the last process
 * listening on it has exited, however it ended, and keeps it while that process is suspended, so
 * whether the pipe still exists (`pipeHolder`) says whether that process runs, whatever its pid
 * names now. Nothing here starts a program on Windows.
 */
import { createServer } from "node:net";
import {
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Predicate,
  Result,
  Schema,
  Stream,
} from "effect";
import { Base64Url } from "effect/encoding";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * How long one lookup may take. macOS starts `ps` for a start time and `sysctl` for the boot, which
 * take milliseconds, and longer on a busy machine.
 */
const lookupTimeout = Duration.seconds(10);

/** The operating system could not say when a process started, or which boot this is. */
export class ProcessLookupFailed extends Schema.TaggedError<ProcessLookupFailed>()(
  "ProcessLookupFailed",
  { detail: Schema.String },
) {}

/** This process could not listen on a named pipe, so other processes cannot tell that it runs. */
export class PipeUnavailable extends Schema.TaggedError<PipeUnavailable>()("PipeUnavailable", {
  detail: Schema.String,
}) {}

/** Signal 0 checks that a process exists; EPERM means it exists under another user. */
export const processExists = (pid: number) =>
  Effect.try(() => process.kill(pid, 0)).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      Effect.succeed(
        Schema.is(Schema.Struct({ cause: Schema.Struct({ code: Schema.Literal("EPERM") }) }))(
          error,
        ),
      ),
    ),
  );

const failed = (detail: string) => Effect.fail(new ProcessLookupFailed({ detail }));

/** A lookup program, by its full path, and the directory it runs in. */
interface Program {
  readonly command: string;
  readonly cwd: string;
}

/** Run one lookup program: its exit code and trimmed standard output. */
const run = (
  program: Program,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(program.command, args, {
          cwd: program.cwd,
          env: { ...env },
          extendEnv: true,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        }),
      );
      const [code, output] = yield* Effect.all(
        [child.exitCode, child.stdout.pipe(Stream.decodeText(), Stream.mkString)],
        { concurrency: "unbounded" },
      );
      return { code: Number(code), output: output.trim() };
    }),
  ).pipe(
    Effect.timeout(lookupTimeout),
    Effect.mapError(
      (cause) => new ProcessLookupFailed({ detail: `${program.command} failed: ${String(cause)}` }),
    ),
  );

/**
 * Linux: field 22 of `/proc/<pid>/stat`, the clock ticks from boot to the process's start. A
 * zombie has exited, though its pid still shows until its parent collects it.
 */
const linuxStarted = (pid: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs
      .readFileString(`/proc/${pid}/stat`)
      .pipe(Effect.mapError((cause) => new ProcessLookupFailed({ detail: String(cause) })));
    // The command name, field 2, is in parentheses and may hold spaces; field 3 follows it.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const [state, started] = [fields[0], fields[19]];
    if (state === undefined || started === undefined || !/^\d+$/u.test(started))
      return yield* failed(`/proc/${pid}/stat could not be read`);
    return state === "Z" || state === "X" ? Option.none<string>() : Option.some(started);
  });

/**
 * macOS: `ps` prints the second the process started, in UTC whatever the user's time zone, so the
 * same process always reads the same. It prints nothing for a pid no process has.
 */
const macStarted = (pid: number) =>
  Effect.gen(function* () {
    const { code, output } = yield* run(
      { command: "/bin/ps", cwd: "/" },
      ["-o", "stat=", "-o", "lstart=", "-p", String(pid)],
      { LC_ALL: "C", TZ: "UTC0" },
    );
    if (code === 1 && output === "") return Option.none<string>();
    const match = /^(\S+)\s+(\S.*)$/u.exec(output);
    if (code !== 0 || match === null) return yield* failed(`ps could not read process ${pid}`);
    const [, state = "", started = ""] = match;
    return state.startsWith("Z") ? Option.none<string>() : Option.some(started);
  });

type LookupServices = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner;

/**
 * When the process `pid` started, as its operating system records it, in a form that only this
 * machine's boot can compare. None when no process has the pid, or only one that has exited. Fails
 * when the operating system does not say, as when a lookup tool is missing or times out, and on
 * Windows, which is never asked.
 */
export const processStartedAt = (pid: number) =>
  Effect.gen(function* () {
    if (!(yield* processExists(pid))) return Option.none<string>();
    const started: Effect.Effect<
      Option.Option<string>,
      ProcessLookupFailed,
      LookupServices
    > = process.platform === "linux"
      ? linuxStarted(pid)
      : process.platform === "darwin"
        ? macStarted(pid)
        : failed(`Process start times are not read on ${process.platform}`);
    // A process that exits while it is looked up leaves nothing to read.
    return yield* started.pipe(
      Effect.catch((error) =>
        Effect.flatMap(processExists(pid), (alive) =>
          alive ? Effect.fail(error) : Effect.succeed(Option.none<string>()),
        ),
      ),
    );
  });

/**
 * Which boot of which machine this is, as far as a start time needs it. Linux counts start times
 * from boot, as the reader's time namespace offsets that clock, so this is its boot ID, with the
 * pid namespace whose pids a record names and the reader's time namespace; kernels before 5.6 have
 * none. macOS names each boot session with a new UUID. Windows reads no start times.
 */
const bootLookup = Effect.gen(function* () {
  if (process.platform === "linux") {
    const fs = yield* FileSystem.FileSystem;
    const read = Effect.mapError((cause) => new ProcessLookupFailed({ detail: String(cause) }));
    const boot = yield* fs.readFileString("/proc/sys/kernel/random/boot_id").pipe(read);
    const pids = yield* fs.readLink("/proc/self/ns/pid").pipe(read);
    const time = yield* fs.readLink("/proc/self/ns/time").pipe(
      Effect.catchIf(
        (error) => Predicate.isTagged(error.reason, "NotFound"),
        () => Effect.succeed("time:none"),
      ),
      read,
    );
    return `${boot.trim()} ${pids} ${time}`;
  }
  if (process.platform === "darwin") {
    const { code, output } = yield* run({ command: "/usr/sbin/sysctl", cwd: "/" }, [
      "-n",
      "kern.bootsessionuuid",
    ]);
    if (code !== 0 || output === "") return yield* failed("sysctl did not name this boot");
    return output;
  }
  return yield* failed(`Boots are not identified on ${process.platform}`);
});

/** This boot, as `bootLookup` reads it. Read once per process; a failed read is tried again. */
export const bootIdentity = Effect.runSync(
  Effect.cachedWithTTL(bootLookup, (exit) => (Exit.isSuccess(exit) ? Duration.infinity : 0)),
);

/**
 * A process as a record names it: its pid, and on Linux and macOS its start time and boot when
 * they could be read.
 */
export interface RecordedProcess {
  readonly pid: number;
  readonly started?: string | undefined;
  readonly boot?: string | undefined;
}

/**
 * This process's start time and boot, or why they could not be read. Read once per process. None
 * on Windows, where a process is named by the pipe it listens on instead.
 */
const ownLookup = Effect.runSync(
  Effect.cached(
    Effect.gen(function* () {
      if (process.platform === "win32") return {};
      const [started, boot] = yield* Effect.all([processStartedAt(process.pid), bootIdentity], {
        concurrency: "unbounded",
      });
      if (Option.isNone(started))
        return yield* failed("This process was not found among the running processes");
      return { started: started.value, boot };
    }).pipe(Effect.result),
  ),
);

/**
 * This process as it records itself. Read once per process, as `processStartedAt` and
 * `bootIdentity` read every process, so another process reading it finds the same. Only its pid on
 * Windows, and when either cannot be read; `ownProcessUnread` says why.
 */
export const ownProcess = Effect.map(ownLookup, (lookup): RecordedProcess => ({
  pid: process.pid,
  ...(Result.isSuccess(lookup) ? lookup.success : {}),
}));

/** Why this process could not read its own start time or boot, when it could not. */
export const ownProcessUnread = Effect.map(ownLookup, Result.getFailure);

/** A pipe name as `holdPipe` chooses it, so a record can name nothing else for `pipeHolder` to open. */
export const PipeName = Schema.String.check(
  Schema.isPattern(/^\\\\\.\\pipe\\executor-lock-[\w-]{32}$/u),
);

/**
 * Windows: listen on a named pipe with a new random name for the current scope and return that
 * name, so other processes can tell with `pipeHolder` whether this one still runs. Every connection
 * is closed at once; nothing is read or written. The pipe never keeps this process running, and the
 * processes it starts do not inherit it.
 */
export const holdPipe = Effect.gen(function* () {
  const name = `\\\\.\\pipe\\executor-lock-${Base64Url.encode(
    globalThis.crypto.getRandomValues(new Uint8Array(24)),
  )}`;
  yield* Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>, PipeUnavailable>((resume) => {
      const server = createServer((connection) => connection.destroy());
      server.once("error", (cause) =>
        resume(Effect.fail(new PipeUnavailable({ detail: String(cause) }))),
      );
      server.listen(name, () => {
        server.unref();
        resume(Effect.succeed(server));
      });
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );
  return name;
});

/**
 * Windows: where the process listening on `pipe`, as `holdPipe` chose it, is now. Opening the pipe
 * connects to it: that succeeds while its process listens, also while it is suspended, until the
 * connections it has not accepted fill the pipe's few instances, and then fails at once with
 * EBUSY. Either way it runs. Once that process has exited, also when it was killed, Windows has
 * removed the pipe, so the name is not found. The pipe is opened rather than read with `stat`,
 * which now and then finds no pipe while checks overlap although its process listens. `unknown`
 * for any other failure.
 */
export const pipeHolder = (pipe: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* Effect.scoped(fs.open(pipe, { flag: "r" })).pipe(
      Effect.as<ProcessState>("running"),
      Effect.catchIf(
        (error) => Predicate.isTagged(error.reason, "Busy"),
        () => Effect.succeed<ProcessState>("running"),
      ),
      Effect.catchIf(
        (error) => Predicate.isTagged(error.reason, "NotFound"),
        () => Effect.succeed<ProcessState>("exited"),
      ),
      Effect.orElseSucceed((): ProcessState => "unknown"),
    );
  });

/**
 * Where the process a record names is now:
 * - `running`: on this boot, its pid runs with the start time it recorded.
 * - `exited`: on this boot, no process has its pid, or another process does.
 * - `elsewhere`: it was recorded on another boot or machine, or without its start time, as on
 *   Windows, so this machine's processes say nothing about it.
 * - `unknown`: this boot, or the start time of the process its pid now names, cannot be read.
 *
 * Only `running` and `exited` are certain; callers treat `elsewhere` and `unknown` alike.
 * `pipeHolder` gives the same states on Windows.
 */
export type ProcessState = "running" | "exited" | "elsewhere" | "unknown";

/** Where the process `recorded` names is now. */
export const recordedProcess = (
  recorded: RecordedProcess,
): Effect.Effect<ProcessState, never, LookupServices> =>
  Effect.gen(function* () {
    if (recorded.started === undefined || recorded.boot === undefined) return "elsewhere";
    // A pid no process has needs no start time, only the boot that says the record is this one's.
    const exists = yield* processExists(recorded.pid);
    const boot = yield* bootIdentity.pipe(Effect.option);
    if (Option.isNone(boot)) return "unknown";
    if (boot.value !== recorded.boot) return "elsewhere";
    if (!exists) return "exited";
    const started = yield* processStartedAt(recorded.pid).pipe(Effect.option);
    if (Option.isNone(started)) return "unknown";
    return Option.isSome(started.value) && started.value.value === recorded.started
      ? "running"
      : "exited";
  });
