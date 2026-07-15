import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  recoverExecutionBody,
  type CodeExecutor,
  type ExecuteResult,
  type SandboxToolInvoker,
} from "@executor-js/codemode-core";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import {
  type DenoPermissions,
  type DenoWorkerProcess,
  spawnDenoWorkerProcess,
} from "./deno-worker-process";

export type { DenoPermissions };

export type DenoSubprocessExecutorOptions = {
  denoExecutable?: string;
  timeoutMs?: number;
  permissions?: DenoPermissions;
};

const IPC_PREFIX = "@@executor-ipc@@";
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class DenoSpawnError extends Data.TaggedError("DenoSpawnError")<{
  readonly executable: string;
  readonly reason: unknown;
}> {
  override get message() {
    const code =
      typeof this.reason === "object" && this.reason !== null && "code" in this.reason
        ? String((this.reason as { code?: unknown }).code)
        : null;

    return code === "ENOENT"
      ? `Failed to spawn Deno subprocess: Deno executable "${this.executable}" was not found. Install Deno or set DENO_BIN.`
      : `Failed to spawn Deno subprocess: ${this.reason instanceof Error ? this.reason.message : String(this.reason)}`;
  }
}

class DenoProcessWriteError extends Data.TaggedError("DenoProcessWriteError")<{
  readonly reason: unknown;
}> {
  override get message() {
    const detail = this.reason instanceof Error ? this.reason.message : String(this.reason);
    return `Failed to write to Deno subprocess stdin: ${detail}`;
  }
}

// ---------------------------------------------------------------------------
// IPC schemas
// ---------------------------------------------------------------------------

const WorkerToolCallMessage = Schema.Struct({
  type: Schema.Literal("tool_call"),
  nonce: Schema.String,
  requestId: Schema.String,
  toolPath: Schema.String,
  args: Schema.Unknown,
});

const WorkerCompletedMessage = Schema.Struct({
  type: Schema.Literal("completed"),
  nonce: Schema.String,
  result: Schema.Unknown,
  output: Schema.optional(Schema.Array(Schema.Unknown)),
  logs: Schema.optional(Schema.Array(Schema.String)),
});

const WorkerFailedMessage = Schema.Struct({
  type: Schema.Literal("failed"),
  nonce: Schema.String,
  error: Schema.String,
  output: Schema.optional(Schema.Array(Schema.Unknown)),
  logs: Schema.optional(Schema.Array(Schema.String)),
});

const WorkerMessage = Schema.Union([
  WorkerToolCallMessage,
  WorkerCompletedMessage,
  WorkerFailedMessage,
] as const);
const decodeWorkerMessage = Schema.decodeUnknownOption(WorkerMessage);

type WorkerToHostMessage = typeof WorkerMessage.Type;

// ---------------------------------------------------------------------------
// Deno binary resolution
// ---------------------------------------------------------------------------

const defaultDenoExecutable = (): string => {
  const configured = process.env.DENO_BIN?.trim();
  if (configured) return configured;

  const isWindows = process.platform === "win32";
  const home = (process.env.HOME || process.env.USERPROFILE)?.trim();
  if (home) {
    const installedPath = isWindows ? `${home}\\.deno\\bin\\deno.exe` : `${home}/.deno/bin/deno`;
    const result = spawnSync(installedPath, ["--version"], {
      stdio: "ignore",
      timeout: 5000,
    });
    if (result.error === undefined && result.status === 0) return installedPath;
  }

  return "deno";
};

// ---------------------------------------------------------------------------
// Worker script resolution
// ---------------------------------------------------------------------------

const resolveWorkerScriptPath = (): string => {
  const moduleUrl = String(import.meta.url);
  try {
    const workerUrl = new URL("./deno-subprocess-worker.mjs", moduleUrl);
    if (workerUrl.protocol === "file:") return fileURLToPath(workerUrl);
    return workerUrl.pathname.length > 0 ? workerUrl.pathname : workerUrl.toString();
  } catch {
    return moduleUrl;
  }
};

let cachedWorkerScriptPath: string | undefined;
const workerScriptPath = (): string => (cachedWorkerScriptPath ??= resolveWorkerScriptPath());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type HostToWorkerMessage =
  | { type: "start"; code: string; nonce: string }
  | {
      type: "tool_result";
      nonce: string;
      requestId: string;
      ok: boolean;
      value?: unknown;
      error?: string;
    };

const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const squashed = Cause.squash(cause);
  if (squashed instanceof Error) {
    return squashed.cause instanceof Error ? squashed.cause.message : squashed.message;
  }
  return String(squashed);
};

const writeMessage = (
  worker: DenoWorkerProcess,
  message: HostToWorkerMessage,
): Effect.Effect<void, DenoProcessWriteError> =>
  Effect.tryPromise({
    try: () => worker.write(`${JSON.stringify(message)}\n`),
    catch: (reason) => new DenoProcessWriteError({ reason }),
  });

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

const executeInDeno = (
  code: string,
  toolInvoker: SandboxToolInvoker,
  options: DenoSubprocessExecutorOptions,
): Effect.Effect<ExecuteResult, never> => {
  const recoveredBody = recoverExecutionBody(code);
  const denoExecutable = options.denoExecutable ?? defaultDenoExecutable();
  const timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const nonce = crypto.randomUUID();

  return Effect.gen(function* () {
    const runSync = Effect.runSync;

    // Queue bridges Node callbacks → Effect fibers
    const messages = yield* Queue.unbounded<WorkerToHostMessage>();

    // Terminal result — resolved once by completed/failed/error/exit
    const result = yield* Deferred.make<ExecuteResult>();

    const completeWith = (value: ExecuteResult): Effect.Effect<boolean> =>
      Deferred.complete(result, Effect.succeed(value));

    // -----------------------------------------------------------------------
    // Spawn subprocess — callbacks only do simple synchronous pushes
    // -----------------------------------------------------------------------

    const worker = yield* Effect.try({
      try: () =>
        spawnDenoWorkerProcess(
          {
            executable: denoExecutable,
            scriptPath: workerScriptPath(),
            permissions: options.permissions,
          },
          {
            onStdoutLine: (rawLine) => {
              const line = rawLine.trim();
              if (!line.startsWith(IPC_PREFIX)) return;

              try {
                const decoded = decodeWorkerMessage(JSON.parse(line.slice(IPC_PREFIX.length)));
                if (Option.isSome(decoded) && decoded.value.nonce === nonce) {
                  runSync(Queue.offer(messages, decoded.value as WorkerToHostMessage));
                }
              } catch {
                // Ignore malformed sandbox output. It is not trusted IPC.
              }
            },
            onStderr: () => {},
            onError: (cause) => {
              runSync(
                completeWith({
                  result: null,
                  error: new DenoSpawnError({
                    executable: denoExecutable,
                    reason: cause,
                  }).message,
                }),
              );
            },
            onStdinError: (cause) => {
              runSync(
                completeWith({
                  result: null,
                  error: new DenoProcessWriteError({ reason: cause }).message,
                }),
              );
            },
            onExit: (exitCode, signal) => {
              runSync(
                completeWith({
                  result: null,
                  error: `Deno subprocess exited unexpectedly (code=${String(exitCode)} signal=${String(signal)})`,
                }),
              );
            },
          },
        ),
      catch: (cause) => new DenoSpawnError({ executable: denoExecutable, reason: cause }),
    });

    const startError = yield* Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => worker.ready,
        catch: (reason) => new DenoSpawnError({ executable: denoExecutable, reason }),
      });
      yield* writeMessage(worker, { type: "start", code: recoveredBody, nonce });
    }).pipe(
      Effect.as<Error | undefined>(undefined),
      Effect.catch((error) => Effect.succeed(error)),
      Effect.onInterrupt(() => Effect.sync(worker.dispose)),
    );
    if (startError) {
      worker.dispose();
      return { result: null, error: startError.message };
    }

    // Set up timeout — kills process and completes the deferred
    const timer = setTimeout(() => {
      worker.dispose();
      runSync(
        completeWith({
          result: null,
          error: `Deno subprocess execution timed out after ${timeoutMs}ms`,
        }),
      );
    }, timeoutMs);

    // -----------------------------------------------------------------------
    // Message processing fiber — tool calls happen here, inside Effect
    // -----------------------------------------------------------------------

    const processFiber = yield* Effect.forkChild(
      Effect.gen(function* () {
        while (true) {
          const msg = yield* Queue.take(messages);

          switch (msg.type) {
            case "tool_call": {
              const toolResult = yield* toolInvoker
                .invoke({ path: msg.toolPath, args: msg.args })
                .pipe(
                  Effect.map(
                    (value): HostToWorkerMessage => ({
                      type: "tool_result",
                      nonce,
                      requestId: msg.requestId,
                      ok: true,
                      value,
                    }),
                  ),
                  Effect.catchCause((cause) =>
                    Effect.succeed<HostToWorkerMessage>({
                      type: "tool_result",
                      nonce,
                      requestId: msg.requestId,
                      ok: false,
                      error: causeMessage(cause),
                    }),
                  ),
                );

              const writeSucceeded = yield* writeMessage(worker, toolResult).pipe(
                Effect.as(true),
                Effect.catchTag("DenoProcessWriteError", (error) =>
                  completeWith({ result: null, error: error.message }).pipe(Effect.as(false)),
                ),
              );
              if (!writeSucceeded) {
                return;
              }
              break;
            }

            case "completed": {
              yield* completeWith({
                result: msg.result,
                output:
                  Array.isArray(msg.output) && msg.output.length > 0
                    ? (msg.output as ExecuteResult["output"])
                    : undefined,
                logs: msg.logs as string[] | undefined,
              });
              return;
            }

            case "failed": {
              yield* completeWith({
                result: null,
                error: msg.error,
                output:
                  Array.isArray(msg.output) && msg.output.length > 0
                    ? (msg.output as ExecuteResult["output"])
                    : undefined,
                logs: msg.logs as string[] | undefined,
              });
              return;
            }
          }
        }
      }),
    );

    // -----------------------------------------------------------------------
    // Await result with timeout, then clean up
    // -----------------------------------------------------------------------

    const output = yield* Deferred.await(result).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          clearTimeout(timer);
          yield* Fiber.interrupt(processFiber);
          worker.dispose();
        }),
      ),
    );

    return output;
  }).pipe(
    Effect.catchTag("DenoSpawnError", (e) =>
      Effect.succeed<ExecuteResult>({ result: null, error: e.message }),
    ),
  );
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const isDenoAvailable = (executable: string = defaultDenoExecutable()): boolean => {
  const result = spawnSync(executable, ["--version"], {
    stdio: "ignore",
    timeout: 5000,
  });
  return result.error === undefined && result.status === 0;
};

export const makeDenoSubprocessExecutor = (
  options: DenoSubprocessExecutorOptions = {},
): CodeExecutor<never> => ({
  execute: (code: string, toolInvoker: SandboxToolInvoker) =>
    executeInDeno(code, toolInvoker, options),
});
