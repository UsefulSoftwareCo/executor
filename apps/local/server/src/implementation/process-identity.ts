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

const lookupTimeout = Duration.seconds(10);

export class ProcessLookupFailed extends Schema.TaggedError<ProcessLookupFailed>()(
  "ProcessLookupFailed",
  { detail: Schema.String },
) {}

export class PipeUnavailable extends Schema.TaggedError<PipeUnavailable>()("PipeUnavailable", {
  detail: Schema.String,
}) {}

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

interface Program {
  readonly command: string;
  readonly cwd: string;
}

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

const linuxStarted = (pid: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs
      .readFileString(`/proc/${pid}/stat`)
      .pipe(Effect.mapError((cause) => new ProcessLookupFailed({ detail: String(cause) })));
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const [state, started] = [fields[0], fields[19]];
    if (state === undefined || started === undefined || !/^\d+$/u.test(started))
      return yield* failed(`/proc/${pid}/stat could not be read`);
    return state === "Z" || state === "X" ? Option.none<string>() : Option.some(started);
  });

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
    return yield* started.pipe(
      Effect.catch((error) =>
        Effect.flatMap(processExists(pid), (alive) =>
          alive ? Effect.fail(error) : Effect.succeed(Option.none<string>()),
        ),
      ),
    );
  });

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

export const bootIdentity = Effect.runSync(
  Effect.cachedWithTTL(bootLookup, (exit) => (Exit.isSuccess(exit) ? Duration.infinity : 0)),
);

export interface RecordedProcess {
  readonly pid: number;
  readonly started?: string | undefined;
  readonly boot?: string | undefined;
}

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

export const ownProcess = Effect.map(ownLookup, (lookup): RecordedProcess => ({
  pid: process.pid,
  ...(Result.isSuccess(lookup) ? lookup.success : {}),
}));

export const ownProcessUnread = Effect.map(ownLookup, Result.getFailure);

export const PipeName = Schema.String.check(
  Schema.isPattern(/^\\\\\.\\pipe\\executor-lock-[\w-]{32}$/u),
);

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

export type ProcessState = "running" | "exited" | "elsewhere" | "unknown";

export const recordedProcess = (
  recorded: RecordedProcess,
): Effect.Effect<ProcessState, never, LookupServices> =>
  Effect.gen(function* () {
    if (recorded.started === undefined || recorded.boot === undefined) return "elsewhere";
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
