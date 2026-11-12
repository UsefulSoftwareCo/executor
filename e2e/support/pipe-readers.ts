/**
 * Readers that misbehave the way real ones do: one that closes the pipe early, as `head -c` does,
 * one that stops reading while the command still has output to write, and one that goes away
 * while a server keeps running.
 *
 * Each runs as a Node program that starts the command itself, since only the process holding a
 * pipe's ends can close or stall it, and prints what it saw as JSON.
 */
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** What the reader does with the command's output. */
export type Reader =
  /** Read at least `bytes` of stdout, then close the pipe. */
  | { readonly mode: "head"; readonly bytes: number }
  /**
   * Give the command a stderr pipe already full and never read. Read stdout until the server
   * prints its connection link, which it prints only after logging its startup on stderr, and wait
   * until the server at `origin` is ready, then stop it.
   */
  | { readonly mode: "stalled"; readonly origin: string }
  /**
   * Read stdout until the server prints its connection link and is ready at `origin`, or without
   * one at the `Executor:` origin it prints, then close the `stream` pipe and create the `gate`
   * file, if any. After `holdMs`, in which the server writes that stream again, check that it
   * is still ready, stop it and check that its origin then refuses connections.
   */
  | {
      readonly mode: "late";
      readonly origin?: string;
      readonly stream: "stdout" | "stderr";
      readonly gate?: string;
      readonly holdMs: number;
    };

/**
 * A server is stopped with SIGTERM, except on Windows, where a signal ends a process at once and
 * skips its shutdown; there the reader writes to the private fd3 pipe, which `e2e-process.ts`
 * turns into the SIGTERM event the product listens for. `late` always uses that pipe, so it stops
 * the server the same way on every platform.
 */
const reader = `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { connect } from "node:net";
const [spec, command, ...args] = process.argv.slice(2);
const reader = JSON.parse(spec);
const report = (fields) => console.log(JSON.stringify(fields));
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
if (reader.mode === "head") {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let read = 0, closedAt, stderr = "";
  child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
  child.stdout.on("data", (chunk) => {
    read += chunk.length;
    if (read < reader.bytes || closedAt !== undefined) return;
    closedAt = performance.now();
    child.stdout.destroy();
  });
  child.on("close", (code, signal) =>
    report({ code, signal, read, stderr, millisecondsAfterClose: performance.now() - (closedAt ?? NaN) }),
  );
} else {
  let child, stderr = "", signalledAt, hung, reported = false, answeredAfterClose, refusedAfterExit;
  let pipeFullAtSignal;
  let origin = reader.origin;
  // What the report waits for once the command exits.
  let afterExit = Promise.resolve();
  const cleanup = [];
  const start = (output) => {
    child = spawn(command, args, {
      stdio: ["ignore", "pipe", output, "pipe"],
      env: { ...process.env, EXECUTOR_TEST_STOP_FD: "3" },
    });
    child.stderr?.setEncoding("utf8").on("data", (text) => (stderr += text));
    // A request to a server that has already exited fails; its exit is what gets reported.
    child.stdio[3].on("error", () => {});
    child.on("exit", (code, signal) => {
      const exitedAt = performance.now();
      clearTimeout(hung);
      for (const other of cleanup) other.kill("SIGKILL");
      // A process the command left running can hold stderr open, so stop waiting for it soon.
      const done = () => {
        if (reported) return;
        reported = true;
        for (const pipe of [child.stdout, child.stderr, child.stdio[3]]) pipe?.destroy();
        afterExit.then(() =>
          report({
            code,
            signal,
            stderr,
            answeredAfterClose,
            refusedAfterExit,
            pipeFullAtSignal,
            millisecondsAfterSignal: exitedAt - (signalledAt ?? NaN),
          }),
        );
      };
      const settled = setTimeout(done, 2_000);
      (child.stderr ?? child.stdout).on("close", () => (clearTimeout(settled), done()));
    });
  };
  const request = () => child.stdio[3].write("stop");
  const running = () => child.exitCode === null && child.signalCode === null;
  const stop = (how) => {
    if (!running()) return;
    signalledAt = performance.now();
    how();
    hung = setTimeout(() => child.kill("SIGKILL"), 20_000);
  };
  // A starting server answers 503 until its product is composed; only a ready one answers 200.
  // A request the starting server accepted may never be answered.
  const isReady = () =>
    fetch(new URL("/api/service", origin), { signal: AbortSignal.timeout(2_000) }).then(
      async (response) => response.status === 200 && (await response.json()).status === "ready",
      () => false,
    );
  // Only a refused connection shows that nothing listens; a listener that accepts and never
  // answers is still there.
  const refuses = () =>
    new Promise((resolve) => {
      const { hostname, port } = new URL(origin);
      const socket = connect({ host: hostname, port: Number(port) });
      const settle = (refused) => {
        socket.destroy();
        resolve(refused);
      };
      socket.setTimeout(2_000, () => settle(false));
      socket.once("connect", () => settle(false));
      socket.once("error", (error) => settle(error.code === "ECONNREFUSED"));
    });
  const deadline = Date.now() + 120_000;
  const ready = async () => {
    while (running() && Date.now() < deadline) {
      if (await isReady()) return true;
      await wait(200);
    }
    return false;
  };
  // Resolves once the server prints its connection link; without an origin, the server's is known
  // only then.
  const linked = () => {
    let printed = "";
    return new Promise((resolve) =>
      child.stdout.setEncoding("utf8").on("data", (text) => {
        printed += text;
        origin ??= /^Executor: (\\S+)$/mu.exec(printed)?.[1];
        if (/#pair=/u.test(printed)) resolve();
      }),
    );
  };
  if (reader.mode === "stalled") {
    // One process holds the pipe's read end and never reads; another fills the pipe and waits
    // there while it is full, so none of the command's writes to it can complete. This program
    // never writes to the pipe, since a command that makes it blocking would block this program too.
    const idle = ["-e", "setInterval(() => {}, 1 << 30)"];
    const holder = spawn(process.execPath, idle, { stdio: ["pipe", "ignore", "ignore"] });
    const filler = spawn(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(1 << 20))"], {
      stdio: ["ignore", holder.stdin, "ignore"],
    });
    cleanup.push(holder, filler);
    filler.on("spawn", () => {
      start(holder.stdin);
      linked()
        .then(ready)
        .then((answered) => {
          if (!answered) return child.kill("SIGKILL");
          // The filler is still waiting to write, so the pipe is still full.
          pipeFullAtSignal = filler.exitCode === null && filler.signalCode === null;
          stop(process.platform === "win32" ? request : () => child.kill("SIGTERM"));
        });
    });
  } else {
    start("pipe");
    linked()
      .then(ready)
      .then(async (answered) => {
        if (!answered) return child.kill("SIGKILL");
        child[reader.stream].destroy();
        if (reader.gate !== undefined) writeFileSync(reader.gate, "");
        await wait(reader.holdMs);
        answeredAfterClose = running() && (await isReady());
        // A server in another process, as \`--standalone\` runs, stops with the command: its
        // origin refuses connections within 15 seconds of the command's exit.
        if (running())
          afterExit = new Promise((resolve) => child.once("exit", resolve)).then(async () => {
            const until = Date.now() + 15_000;
            while (Date.now() < until) {
              if (await refuses()) return void (refusedAfterExit = true);
              await wait(200);
            }
            refusedAfterExit = false;
          });
        stop(request);
      });
  }
}
`;

const Observed = Schema.fromJsonString(
  Schema.Struct({
    code: Schema.NullOr(Schema.Number),
    signal: Schema.NullOr(Schema.String),
    stderr: Schema.String,
    read: Schema.optional(Schema.Number),
    millisecondsAfterClose: Schema.optional(Schema.NullOr(Schema.Number)),
    millisecondsAfterSignal: Schema.optional(Schema.NullOr(Schema.Number)),
    answeredAfterClose: Schema.optional(Schema.Boolean),
    refusedAfterExit: Schema.optional(Schema.Boolean),
    pipeFullAtSignal: Schema.optional(Schema.Boolean),
  }),
);

/** Run the command under one of the readers, with this environment, and return what it saw. */
export const throughPipe = (
  spec: Reader,
  command: { readonly command: string; readonly args: ReadonlyArray<string> },
  env: Readonly<Record<string, string>>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path,
        processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-pipe-reader-" });
      const script = path.join(directory, "reader.mjs");
      yield* fs.writeFileString(script, reader);
      const child = yield* processes.spawn(
        ChildProcess.make(
          "node",
          [script, JSON.stringify(spec), command.command, ...command.args],
          {
            extendEnv: false,
            env: { PATH: process.env.PATH ?? "", ...env },
            stdout: "pipe",
            stderr: "pipe",
            forceKillAfter: "3 seconds",
          },
        ),
      );
      const [, printed, failed] = yield* Effect.all(
        [
          child.exitCode,
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        ],
        { concurrency: 3 },
      ).pipe(Effect.timeout("3 minutes"));
      return yield* Schema.decodeUnknownEffect(Observed)(printed).pipe(
        Effect.catch(() => Effect.die(`The pipe reader printed no result: ${failed}`)),
      );
    }),
  );
