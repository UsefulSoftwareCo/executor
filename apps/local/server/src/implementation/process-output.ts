import { Console as NodeConsole } from "node:console";
import { createWriteStream } from "node:fs";
import { Writable, finished } from "node:stream";
import { isatty } from "node:tty";
import { Cause, Effect, Exit, Runtime, type Console } from "effect";

const signalDrainMs = 500;

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
  let writeFailure: unknown;
  let serving = false;
  let lastLine: () => string | undefined = () => undefined;

  const refused = (output: "stdout" | "stderr", error: unknown) => {
    const readerClosed =
      typeof error === "object" && error !== null && "code" in error && error.code === "EPIPE";
    if (!readerClosed && writeFailure === undefined) {
      writeFailure = error;
      const message = `Executor could not write its output: ${error instanceof Error ? error.message : String(error)}`;
      if (output === "stdout") processConsole.error(message);
      else if (serving) processConsole.log(message);
    }
    if (!serving) closeOutput();
  };

  const forward = (output: "stdout" | "stderr", target: Writable) => {
    let failed = false;
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
      const last = lastLine();
      if (last !== undefined) processConsole.error(last);
      end(stdout, () => {
        const bound = last === undefined ? undefined : setTimeout(done, signalDrainMs);
        end(stderr, () => {
          clearTimeout(bound);
          done();
        });
      });
    });

  return {
    console: processConsole,
    closed: Effect.promise(() => closed),
    serve: <A, E, R>(command: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        serving = true;
        return command;
      }),
    teardown,
    last: (line: () => string | undefined) => {
      lastLine = line;
    },
  };
};

export const processOutput = makeOutput();
