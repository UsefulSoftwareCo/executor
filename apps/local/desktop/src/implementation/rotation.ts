/** Local API key rotation. The backend owns key storage, so rotation runs its entry after it stops. */
import { dialog } from "electron";
import { Effect, Schema, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { RotationResult } from "../contracts/desktop.ts";

const show = (options: Electron.MessageBoxOptions) =>
  Effect.promise(() => dialog.showMessageBox(options));

/**
 * Rotate with the backend entry once no server holds the data directory. The result is one
 * stdout line; its message is the server's sanitized configuration text and never a key.
 */
export const rotateAfterStop = (options: {
  readonly executable: string;
  readonly entry: string;
  readonly cwd: string;
  readonly directory: string;
}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(options.executable, [options.entry, "--rotate-api-key"], {
            cwd: options.cwd,
            env: { ELECTRON_RUN_AS_NODE: "1", EXECUTOR_DATA_DIR: options.directory },
            extendEnv: true,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
          }),
        );
        const output = yield* child.stdout.pipe(Stream.decodeText, Stream.mkString);
        yield* child.exitCode;
        const line = output.trim().split("\n").at(-1) ?? "";
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RotationResult))(line);
      }),
    ).pipe(
      Effect.tapCause((cause) => Effect.logError("Desktop key rotation did not finish", cause)),
      Effect.catch(() =>
        Effect.succeed(
          RotationResult.make({
            version: 1,
            rotated: false,
            message: "Executor could not run the key rotation. The API key was not changed.",
          }),
        ),
      ),
    );
    yield* show(
      result.rotated
        ? {
            type: "info",
            message: "The local API key was rotated.",
            detail:
              "Executor restarts now. Update scripts and clients that used the previous key. Browser sessions and MCP sign-ins are kept.",
          }
        : { type: "error", message: "The local API key was not rotated.", detail: result.message },
    );
  });

/** Confirm rotation, then hand the caller the work to run once the backend has stopped. */
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
          "Executor restarts with a new key. Scripts and clients that send the current key stop working until you update them. Saved accounts, browser sessions and MCP sign-ins are kept.",
        buttons: ["Rotate and restart", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      });
      if (answer.response === 0) request();
    });
    return lock.withPermitsIfAvailable(1)(confirm);
  });
