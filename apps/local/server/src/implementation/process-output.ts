/**
 * The CLI's console, written through the process's stdout and stderr streams.
 *
 * Bun's native `console.log` and `console.error` write a non-blocking pipe once and drop what the
 * pipe does not take, so the release executable's piped output stopped at 64 KiB. Node queues
 * pipe writes, and `process.exit` drops the ones still queued. The streams wait for the pipe, and
 * `teardown` exits once every write the console made has reached it.
 *
 * A terminal keeps the runtime's own console, which writes it in full and keeps its formatting,
 * such as Bun's red errors. `isatty` leaves that process stream unopened: Bun makes a process
 * stream non-blocking once it exists.
 *
 * A reader that closes the pipe early, as `head` does, ends the command quietly. Any other failed
 * write, such as a full disk, ends it too, is reported once on stderr, and fails the command.
 * A server keeps serving instead: its clients, not its output's reader, decide when it stops. It
 * drops what it cannot write and reports any other failed write once on its other stream.
 */
import { Console as NodeConsole } from "node:console";
import { createWriteStream } from "node:fs";
import { Writable, finished } from "node:stream";
import { isatty } from "node:tty";
import { Cause, Effect, Exit, Runtime, type Console } from "effect";

/** After a signal, waits at most this long for the output, since a reader that stopped reading
 * would otherwise hold up shutdown. */
const signalDrainMs = 500;

/**
 * Where the console writes one of the process's descriptors. On Windows a process stream writes a
 * pipe synchronously, so a reader that stopped reading blocked the whole process at its next log:
 * a server could neither answer nor stop. There the descriptor is written with the file system's
 * asynchronous writes, which wait in a worker thread instead. Elsewhere the process stream already
 * waits for the pipe without blocking.
 */
const descriptor = (fd: 1 | 2, stream: () => NodeJS.WriteStream): Writable =>
  process.platform === "win32" ? createWriteStream("", { fd, autoClose: false }) : stream();

const end = (stream: Writable | undefined, then: () => void) => {
  if (stream === undefined) return then();
  finished(stream, () => then());
  stream.end();
};

const makeOutput = () => {
  let closeOutput = () => {};
  const closed = new Promise<void>((resolve) => {
    closeOutput = resolve;
  });
  /** The first write a process stream refused, other than a reader closing the pipe. */
  let writeFailure: unknown;
  /** Whether the command serves until it is stopped, so its output never ends it. */
  let serving = false;

  const refused = (output: "stdout" | "stderr", error: unknown) => {
    const readerClosed =
      typeof error === "object" && error !== null && "code" in error && error.code === "EPIPE";
    if (!readerClosed && writeFailure === undefined) {
      writeFailure = error;
      const message = `Executor could not write its output: ${error instanceof Error ? error.message : String(error)}`;
      // A command's stdout can be another program's input; a server's is only its log.
      if (output === "stdout") processConsole.error(message);
      else if (serving) processConsole.log(message);
    }
    if (!serving) closeOutput();
  };

  /**
   * Passes each write on and finishes it when the process stream has written it. Once the process
   * stream refuses a write, the rest are dropped.
   */
  const forward = (output: "stdout" | "stderr", target: Writable) => {
    let failed = false;
    // The write the process stream has not finished; a failure finishes it too.
    let pending: (() => void) | undefined;
    const fail = (error: unknown) => {
      if (failed) return;
      failed = true;
      refused(output, error);
      pending?.();
    };
    target.on("error", fail);
    return new Writable({
      decodeStrings: false,
      write: (chunk, encoding, callback) => {
        if (failed) return callback();
        const done = () => {
          if (pending !== done) return;
          pending = undefined;
          callback();
        };
        pending = done;
        try {
          target.write(chunk, encoding, (error) => {
            if (error) fail(error);
            done();
          });
        } catch (error) {
          // Bun throws a failed write to a file, such as /dev/full, instead of reporting it.
          fail(error);
        }
      },
    });
  };

  const stdout = isatty(1)
    ? undefined
    : forward(
        "stdout",
        descriptor(1, () => process.stdout),
      );
  const stderr = isatty(2)
    ? undefined
    : forward(
        "stderr",
        descriptor(2, () => process.stderr),
      );
  const toStdout = stdout === undefined ? globalThis.console : new NodeConsole({ stdout });
  const toStderr = stderr === undefined ? globalThis.console : new NodeConsole({ stdout: stderr });
  const processConsole: Console.Console = {
    ...toStdout,
    assert: toStderr.assert,
    error: toStderr.error,
    trace: toStderr.trace,
    warn: toStderr.warn,
  };

  /**
   * runMain's teardown, which exits only once the console's output is written: it ends a failed
   * or interrupted command with process.exit, which drops output a pipe has not taken yet. A
   * failed write fails a command that otherwise succeeded.
   */
  const teardown: Runtime.Teardown = (exit, onExit) =>
    Runtime.defaultTeardown(exit, (code) => {
      let exited = false;
      const done = () => {
        if (exited) return;
        exited = true;
        clearTimeout(deadline);
        onExit(writeFailure !== undefined && code === 0 ? 1 : code);
      };
      const deadline =
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          ? setTimeout(done, signalDrainMs)
          : undefined;
      // stdout first, so stderr is still open to report a failed write.
      end(stdout, () => end(stderr, done));
    });

  return {
    console: processConsole,
    /** Completes when a command that is not serving can no longer write its output. */
    closed: Effect.promise(() => closed),
    /** Runs a command that serves until it is stopped, which output it cannot write never ends. */
    serve: <A, E, R>(command: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        serving = true;
        return command;
      }),
    teardown,
  };
};

export const processOutput = makeOutput();
