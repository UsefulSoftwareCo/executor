/**
 * Local API key rotation. The CLI owns key storage, so the desktop runs `executor service rotate-key` while
 * the background server is stopped, then starts it again with the new key.
 */
import { dialog } from "electron";
import { Effect, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** How much of a failed rotation's message is shown. */
const messageLimit = 2000;

const show = (options: Electron.MessageBoxOptions) =>
  Effect.promise(() => dialog.showMessageBox(options));

/**
 * Run `service rotate-key` with the CLI `command`, in its environment `env`, on `directory`. Its stderr
 * holds the CLI's sanitized message when it fails, and never a key.
 */
export const rotateKey = (options: {
  readonly command: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly directory: string;
}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const [executable = "", ...args] = options.command;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(executable, [...args, "service", "rotate-key"], {
            env: { ...options.env, EXECUTOR_DATA_DIR: options.directory },
            extendEnv: false,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
          }),
        );
        const [message, code] = yield* Effect.all(
          [child.stderr.pipe(Stream.decodeText, Stream.mkString), child.exitCode],
          { concurrency: 2 },
        );
        return { rotated: code === 0, message: message.trim().slice(-messageLimit) };
      }),
    );
  }).pipe(
    Effect.tapCause((cause) => Effect.logError("Desktop key rotation did not finish", cause)),
    Effect.catch(() => Effect.succeed({ rotated: false, message: "" })),
  );

/** Tell the person how the rotation went. */
export const announceRotation = (result: { readonly rotated: boolean; readonly message: string }) =>
  show(
    result.rotated
      ? {
          type: "info",
          message: "The local API key was rotated.",
          detail:
            "Executor's background server restarted with the new key. Update scripts and clients that used the previous key. Browser sessions and MCP sign-ins are kept.",
        }
      : {
          type: "error",
          message: "The local API key was not rotated.",
          detail:
            result.message === ""
              ? "Executor could not run the key rotation. The API key was not changed."
              : result.message,
        },
  );

/** Confirm rotation, then hand the caller the work to run while the server is stopped. */
export const makeRotateKeyAction = (request: () => void) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const confirm = Effect.gen(function* () {
      if (
        process.env.EXECUTOR_API_KEY !== undefined ||
        process.env.EXECUTOR_ENCRYPTION_KEY !== undefined
      ) {
        yield* show({
          type: "info",
          message: "This Executor uses supplied keys.",
          detail:
            "EXECUTOR_API_KEY and EXECUTOR_ENCRYPTION_KEY are set, and Executor never stores them. Change EXECUTOR_API_KEY where you set it.",
        });
        return;
      }
      const answer = yield* show({
        type: "warning",
        message: "Rotate the local API key?",
        detail:
          "Executor's background server restarts with a new key. Scripts and clients that send the current key, including the Executor CLI when EXECUTOR_API_KEY is set, stop working until you update them. Saved accounts, browser sessions and MCP sign-ins are kept.",
        buttons: ["Rotate and restart", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      });
      if (answer.response === 0) request();
    });
    return lock.withPermitsIfAvailable(1)(confirm);
  });
