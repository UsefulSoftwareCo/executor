/**
 * Closing a desktop the way a person quits it, within a bound. Playwright's `close` asks the app
 * to quit and waits, without limit, until its process has exited and every copy of the output
 * pipes it was given is closed. A quit that does not finish would hang the scenario until its
 * test limit, with nothing to say why; past the bound this keeps what the desktop was doing and
 * fails the scenario with it instead.
 */
import type { ElectronApplication } from "playwright";
import { expect } from "vitest";
import {
  Clock,
  Console,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Path,
  Schema,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { closeDurationsFile, desktopEvidenceBase } from "./desktop-close-durations.ts";
import { driver } from "./platform.ts";

/**
 * An orderly quit ends the desktop within a second; one that has not ended it by then has hung.
 * The bound leaves room for a slow runner and stays well inside every desktop scenario's limit.
 */
export const quitBound = Duration.seconds(20);

/**
 * The most each step of a close that passed `quitBound` may take, so the close as a whole is
 * bounded too: reading the inspector's address before the close, asking the inspector what the
 * main process is doing, listing processes, capturing the display, ending the desktop, and
 * waiting for Playwright to see it gone. A capped program (`ps`, `import`, `taskkill`) that
 * outlives its cap is killed a second later, so it adds at most `programEnd`. Reading `/proc`
 * and writing the evidence files have no cap of their own; they take milliseconds.
 */
export const closeEvidenceCaps = {
  inspectorAddress: Duration.seconds(5),
  inspector: Duration.seconds(15),
  processes: Duration.seconds(10),
  display: Duration.seconds(10),
  endDesktop: Duration.seconds(10),
  desktopGone: Duration.seconds(10),
};

/** How long a capped program gets to exit once it is told to stop. */
const programEnd = Duration.seconds(1);

/**
 * The longest a close can take, a hung one included: the bound, every evidence cap and the end of
 * the three capped programs.
 */
export const closeLimit = Object.values(closeEvidenceCaps).reduce(
  (total, cap) => Duration.sum(total, cap),
  Duration.sum(quitBound, Duration.times(programEnd, 3)),
);

/** A program the evidence runs, killed `programEnd` after its cap interrupts it. */
const capped = (command: string, args: ReadonlyArray<string>) =>
  ChildProcess.make(command, [...args], { forceKillAfter: Duration.toMillis(programEnd) });

/** Pairing links carry a one-use credential; kept evidence holds only their shape. */
export const redactLinks = (text: string) =>
  text.replace(/#pair=[a-f0-9]{64}/g, "#pair=<redacted>");

/** What the desktop's main process wrote to stderr, its last `limit` characters, as it arrives. */
export const captureOutput = (electron: ElectronApplication, limit = 64 * 1024) => {
  let output = "";
  electron.process().stderr?.on("data", (chunk: Uint8Array) => {
    output = (output + new TextDecoder().decode(chunk)).slice(-limit);
  });
  return () => output;
};

/** Where Linux says a process is, from `/proc/<pid>/stat`: its state and, while it sleeps, where. */
const linuxState = (pid: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.readFileString(`/proc/${pid}/stat`).pipe(Effect.option);
    if (Option.isNone(stat)) return { state: "gone" };
    // The state follows the command name, which is in parentheses and may contain any character.
    const state = stat.value.charAt(stat.value.lastIndexOf(")") + 2);
    const wchan = yield* fs.readFileString(`/proc/${pid}/wchan`).pipe(Effect.option);
    const tasks = yield* fs.readDirectory(`/proc/${pid}/task`).pipe(Effect.orElseSucceed(() => []));
    const threads: Record<string, number> = {};
    for (const task of tasks) {
      const name = yield* fs
        .readFileString(`/proc/${pid}/task/${task}/comm`)
        .pipe(Effect.orElseSucceed(() => "?"));
      const waits = yield* fs
        .readFileString(`/proc/${pid}/task/${task}/wchan`)
        .pipe(Effect.orElseSucceed(() => "?"));
      const key = `${name.trim()} in ${waits.trim() || "-"}`;
      threads[key] = (threads[key] ?? 0) + 1;
    }
    return { state, wchan: Option.getOrElse(wchan, () => "?"), threads };
  });

/**
 * The processes that hold any of `targets`, the pipes the desktop's output went to, other than
 * `except`. Read from `/proc` on Linux, so it also finds them after the desktop has exited.
 */
const linuxHolders = (targets: ReadonlyArray<string>, except: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (targets.length === 0) return [];
    const holders: Array<{ pid: number; fd: string; pipe: string; command: string }> = [];
    const pids = (yield* fs.readDirectory("/proc").pipe(Effect.orElseSucceed(() => []))).filter(
      (entry) => /^\d+$/u.test(entry) && Number(entry) !== except && Number(entry) !== process.pid,
    );
    for (const pid of pids) {
      const fds = yield* fs.readDirectory(`/proc/${pid}/fd`).pipe(Effect.orElseSucceed(() => []));
      for (const fd of fds) {
        const target = yield* fs.readLink(`/proc/${pid}/fd/${fd}`).pipe(Effect.option);
        if (Option.isNone(target) || !targets.includes(target.value)) continue;
        const command = yield* fs
          .readFileString(`/proc/${pid}/cmdline`)
          .pipe(Effect.orElseSucceed(() => ""));
        holders.push({
          pid: Number(pid),
          fd,
          pipe: target.value,
          command: command.replaceAll("\0", " ").trim().slice(0, 300),
        });
      }
    }
    return holders;
  });

/** The pipes `pid`'s standard output and error go to, while it runs (Linux). */
const linuxOutputPipes = (pid: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const targets = yield* Effect.forEach([1, 2], (fd) =>
      fs.readLink(`/proc/${pid}/fd/${fd}`).pipe(Effect.option),
    );
    return targets.flatMap((target) =>
      Option.isSome(target) && /^(pipe|socket):/u.test(target.value) ? [target.value] : [],
    );
  });

/**
 * Every process in the desktop's process group, which Playwright makes it lead, and in the group
 * of the server `server.json` names, as `ps` lists them (POSIX).
 */
const processRows = (groups: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const lines = yield* processes
      .lines(capped("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,etime=,command="]))
      .pipe(
        Effect.timeout(closeEvidenceCaps.processes),
        Effect.orElseSucceed(() => []),
      );
    return lines.filter((line) => {
      const pgid = Number(line.trim().split(/\s+/u)[2]);
      return groups.includes(pgid);
    });
  });

const InspectorReply = Schema.Struct({
  id: Schema.optional(Schema.Number),
  method: Schema.optional(Schema.String),
  result: Schema.optional(Schema.Unknown),
  params: Schema.optional(Schema.Unknown),
});
const PausedParams = Schema.Struct({
  callFrames: Schema.Array(
    Schema.Struct({
      functionName: Schema.String,
      url: Schema.String,
      location: Schema.Struct({ lineNumber: Schema.Number, columnNumber: Schema.Number }),
    }),
  ),
});

/**
 * Ask the main process's Node inspector what keeps it running: its active handles and requests,
 * and the JavaScript stack of the next code it runs. A main process whose event loop is idle runs
 * none, which says the quit waits on something no callback will end.
 */
const inspect = (url: string) =>
  Effect.gen(function* () {
    const socket = yield* Effect.acquireRelease(
      Effect.callback<WebSocket, string>((resume) => {
        const socket = new WebSocket(url);
        socket.addEventListener("open", () => resume(Effect.succeed(socket)), { once: true });
        socket.addEventListener("error", () => resume(Effect.fail("inspector unreachable")), {
          once: true,
        });
      }),
      (socket) => Effect.sync(() => socket.close()),
    );
    const replies = new Map<number, (result: unknown) => void>();
    const paused = yield* Deferred.make<unknown>();
    socket.addEventListener("message", (event) => {
      const reply = Schema.decodeUnknownOption(Schema.fromJsonString(InspectorReply))(
        String(event.data),
      );
      if (Option.isNone(reply)) return;
      if (reply.value.id !== undefined) replies.get(reply.value.id)?.(reply.value.result);
      else if (reply.value.method === "Debugger.paused")
        Deferred.doneUnsafe(paused, Exit.succeed(reply.value.params));
    });
    let next = 0;
    const send = (method: string, params: Record<string, unknown> = {}) =>
      Effect.callback<unknown>((resume) => {
        next += 1;
        replies.set(next, (result) => resume(Effect.succeed(result)));
        socket.send(JSON.stringify({ id: next, method, params }));
      });
    const resources = yield* send("Runtime.evaluate", {
      returnByValue: true,
      expression: `({
        resources: process.getActiveResourcesInfo(),
        handles: process._getActiveHandles().map((handle) => [
          handle?.constructor?.name,
          handle?.remoteAddress === undefined ? undefined : handle.remoteAddress + ":" + handle.remotePort,
          handle?.pid === undefined ? undefined : "pid " + handle.pid,
        ].filter((part) => part !== undefined).join(" ")),
        requests: process._getActiveRequests().map((request) => request?.constructor?.name),
        uptimeSeconds: process.uptime(),
      })`,
    });
    yield* send("Debugger.enable");
    yield* send("Debugger.pause");
    const frames = (yield* Deferred.await(paused).pipe(Effect.timeoutOption("5 seconds"))).pipe(
      Option.flatMap(Schema.decodeUnknownOption(PausedParams)),
    );
    yield* send("Debugger.resume");
    return {
      resources,
      stack: Option.match(frames, {
        onNone: () => "no JavaScript ran within 5 seconds: the event loop is idle",
        onSome: ({ callFrames }) =>
          callFrames.map(
            (frame) =>
              `${frame.functionName || "<anonymous>"} ${frame.url}:${frame.location.lineNumber + 1}:${frame.location.columnNumber + 1}`,
          ),
      }),
    };
  }).pipe(
    Effect.scoped,
    // A main process blocked in native code, as in a modal box, answers nothing.
    Effect.timeoutOrElse({
      duration: closeEvidenceCaps.inspector,
      orElse: () =>
        Effect.fail(
          `its inspector did not answer within ${Duration.toSeconds(closeEvidenceCaps.inspector)} seconds`,
        ),
    }),
    Effect.match({
      onFailure: (reason) => ({ unavailable: reason }),
      onSuccess: (found) => found,
    }),
  );

const QuitRecord = Schema.fromJsonString(
  Schema.Struct({
    message: Schema.String,
    annotations: Schema.Struct({
      reason: Schema.optional(Schema.String),
      closing: Schema.optional(Schema.String),
      seconds: Schema.optional(Schema.Number),
      outcome: Schema.optional(Schema.String),
      error: Schema.optional(Schema.String),
    }),
  }),
);

/**
 * What the desktop wrote of its quit to stderr (see the desktop's `quitting.ts`), in order: why it
 * quit, the finalizers a slow quit waits on, the first line of an uncaught exception, and whether
 * its scope closed.
 */
const quitRecords = (output: string) => {
  const records = output.split("\n").flatMap((line) => {
    const record = Schema.decodeUnknownOption(QuitRecord)(line.trim());
    if (Option.isNone(record)) return [];
    const { message, annotations } = record.value;
    switch (message) {
      case "Desktop quitting":
        return [`quitting (${annotations.reason ?? "?"})`];
      case "Desktop still quitting":
        return [
          `still closing ${annotations.closing ?? "?"} after ${annotations.seconds ?? "?"} s`,
        ];
      case "Desktop uncaught exception":
        return [
          `uncaught exception while closing ${annotations.closing ?? "?"}: ${redactLinks((annotations.error ?? "").split("\n")[0] ?? "")}`,
        ];
      case "Desktop closed":
        return [
          `scope closed (${annotations.outcome ?? "?"}) after ${annotations.seconds ?? "?"} s`,
        ];
      default:
        return [];
    }
  });
  return records.length === 0 ? "none" : records.join("; ");
};

const ServerPid = Schema.fromJsonString(Schema.Struct({ pid: Schema.Number }));

/**
 * Record how long a close took, so the margin under `quitBound` is measured: one line in the job's
 * log, which every run keeps, and one in `close-durations.jsonl` beside the evidence, which a
 * failed job uploads. `outcome` is `exited`, `already exited` or `did not exit`.
 */
const recordClose = (
  pid: number | undefined,
  started: number,
  outcome: "exited" | "already exited" | "did not exit",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const seconds = ((yield* Clock.currentTimeMillis) - started) / 1_000;
    const scenario = expect.getState().currentTestName ?? "unknown scenario";
    yield* Console.log(
      `desktop close: ${seconds.toFixed(3)} s, ${outcome}, bound ${Duration.toSeconds(quitBound)} s, pid ${pid ?? "unknown"}, ${scenario}`,
    );
    const file = yield* closeDurationsFile;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(
      file,
      `${JSON.stringify({ scenario, pid, seconds, outcome, boundSeconds: Duration.toSeconds(quitBound), at: DateTime.formatIso(yield* DateTime.now) })}\n`,
      { flag: "a" },
    );
  }).pipe(Effect.ignore);

/**
 * Close `electron` as a person quits the desktop, and fail when it has not exited within
 * `quitBound`. The failure keeps, in a new folder under EXECUTOR_E2E_DESKTOP_SCREENSHOTS (by
 * default `.local/desktop-recovery`), what the desktop was doing: whether its main process still
 * runs and where it waits, its threads, its and its server's processes, who else holds its output
 * (Linux), its active handles and next JavaScript stack from its inspector, its stderr, and the
 * desktop's and its server's logs from `data`. Then it ends the desktop's processes, so the
 * scenario's own clean-up runs, and fails with a summary that names the folder.
 */
export const closeDesktop = (
  electron: ElectronApplication,
  options: { readonly data?: string; readonly output?: () => string },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Playwright no longer has the process of a desktop that has already exited, as one whose
    // last window closed; closing it then only settles Playwright's side.
    const started = yield* Clock.currentTimeMillis;
    const launched = yield* Effect.try(() => electron.process()).pipe(Effect.option);
    if (Option.isNone(launched)) {
      yield* driver("close desktop", () => electron.close());
      return yield* recordClose(undefined, started, "already exited");
    }
    const pid = launched.value.pid;
    // Read while the main process still answers: where its inspector listens, and on Linux the
    // pipes its output goes to, which say after it quits who else still holds them.
    const inspector = yield* driver("read the desktop's inspector address", () =>
      electron.evaluate(() => process.getBuiltinModule("node:inspector").url() ?? ""),
    ).pipe(
      Effect.timeoutOption(closeEvidenceCaps.inspectorAddress),
      Effect.map(Option.filter((url) => url !== "")),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    const pipes =
      process.platform === "linux" && pid !== undefined ? yield* linuxOutputPipes(pid) : [];
    const asked = yield* DateTime.now;
    const closing = yield* driver("close desktop", () => electron.close()).pipe(Effect.forkDetach);
    const closed = yield* Fiber.join(closing).pipe(Effect.timeoutOption(quitBound));
    if (Option.isSome(closed)) return yield* recordClose(pid, started, "exited");
    yield* recordClose(pid, started, "did not exit");

    const alive =
      pid !== undefined &&
      (yield* Effect.try(() => process.kill(pid, 0)).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ));
    const state =
      process.platform === "linux" && pid !== undefined ? yield* linuxState(pid) : undefined;
    const holders =
      process.platform === "linux" && pid !== undefined ? yield* linuxHolders(pipes, pid) : [];
    const javascript =
      alive && Option.isSome(inspector)
        ? yield* inspect(inspector.value)
        : { unavailable: alive ? "no inspector address" : "the main process has exited" };
    const server =
      options.data === undefined
        ? Option.none<number>()
        : yield* fs.readFileString(path.join(options.data, "server.json")).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ServerPid)),
            Effect.map(({ pid }) => pid),
            Effect.option,
          );
    const groups = [...(pid === undefined ? [] : [pid]), ...Option.toArray(server)];
    const processes = process.platform === "win32" ? [] : yield* processRows(groups);

    const base = yield* desktopEvidenceBase;
    const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
    const directory = path.resolve(base, `quit-hung-${stamp}-${pid ?? "unknown"}`);
    yield* fs.makeDirectory(directory, { recursive: true });
    const write = (name: string, text: string) =>
      fs.writeFileString(path.join(directory, name), redactLinks(text), { mode: 0o600 });
    yield* write(
      "quit.json",
      JSON.stringify(
        {
          pid,
          askedToQuitAt: DateTime.formatIso(asked),
          boundSeconds: Duration.toSeconds(quitBound),
          mainProcessAlive: alive,
          linux: state,
          outputPipes: pipes,
          outputHeldBy: holders,
          server: Option.getOrUndefined(server),
          javascript,
        },
        null,
        2,
      ),
    );
    yield* write("processes.txt", processes.join("\n"));
    // A native box the main process blocks on, such as Electron's for an uncaught exception, is
    // in no page Playwright can capture; the display shows it. ImageMagick's `import` is optional.
    if (process.platform === "linux" && process.env.DISPLAY !== undefined) {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      yield* spawner
        .lines(capped("import", ["-window", "root", path.join(directory, "display.png")]))
        .pipe(Effect.timeout(closeEvidenceCaps.display), Effect.ignore);
    }
    if (options.output !== undefined) yield* write("stderr.txt", options.output());
    if (options.data !== undefined) {
      const diagnostics = path.join(options.data, "diagnostics");
      const logs = (yield* fs
        .readDirectory(diagnostics)
        .pipe(Effect.orElseSucceed(() => []))).filter((name) => name.endsWith(".jsonl"));
      for (const name of logs)
        yield* fs.readFileString(path.join(diagnostics, name)).pipe(
          Effect.flatMap((text) => write(name, text.slice(-500_000))),
          Effect.ignore,
        );
    }

    // The scenario fails either way; ending the desktop lets its clean-up run.
    if (pid !== undefined && process.platform === "win32") {
      // Playwright starts the desktop through cmd.exe there, so its whole tree is ended.
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      yield* processes
        .lines(capped("taskkill", ["/pid", String(pid), "/t", "/f"]))
        .pipe(Effect.timeout(closeEvidenceCaps.endDesktop), Effect.ignore);
    } else if (pid !== undefined)
      yield* Effect.try(() => process.kill(-pid, "SIGKILL")).pipe(Effect.ignore);
    for (const holder of holders)
      yield* Effect.try(() => process.kill(holder.pid, "SIGKILL")).pipe(Effect.ignore);
    yield* Fiber.await(closing).pipe(Effect.timeoutOption(closeEvidenceCaps.desktopGone));

    const where =
      state === undefined
        ? ""
        : `, state ${state.state}${"wchan" in state ? ` waiting in ${state.wchan}` : ""}`;
    // While the main process runs, its own Chromium processes hold its output too; only holders
    // left once it has exited keep Playwright waiting.
    const holding = [...new Set(holders.map((holder) => holder.pid))].map((holderPid) => {
      const command = holders.find((holder) => holder.pid === holderPid)?.command ?? "";
      const kind = /--type=(\S+)/u.exec(command)?.[1] ?? path.basename(command.split(" ")[0] ?? "");
      return `${holderPid} (${kind})`;
    });
    const stack =
      "stack" in javascript
        ? typeof javascript.stack === "string"
          ? javascript.stack
          : `next JavaScript: ${javascript.stack.slice(0, 3).join(" < ")}`
        : `JavaScript not inspected: ${javascript.unavailable}`;
    return yield* Effect.fail(
      new Error(
        [
          `The desktop (pid ${pid}) did not exit within ${Duration.toSeconds(quitBound)} seconds of being asked to quit.`,
          `Main process: ${alive ? "still running" : "exited"}${where}.`,
          ...(alive || holding.length === 0
            ? []
            : [`Its output is still held by: ${holding.join(", ")}.`]),
          `${stack}.`,
          `The desktop's quit records: ${quitRecords(options.output?.() ?? "")}.`,
          `Evidence: ${directory}`,
        ].join(" "),
      ),
    );
  });
