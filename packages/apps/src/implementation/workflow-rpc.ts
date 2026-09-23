/** RPC adapters expose only parsed values and safe failures to isolated app code. */
import { Cause, Effect, Redacted, Schema } from "effect";
import { ResolvedAccounts } from "../contracts/host.ts";
import {
  WorkflowFailure,
  WorkflowRpcCommand,
  WorkflowRpcResult,
  WorkflowRun,
  WorkflowRunPage,
  WorkflowRunId,
  type WorkflowExecution,
  type WorkflowRpc,
  type WorkflowHostControls,
} from "../contracts/workflows.ts";

/** Bind a private host callback to this invocation; no workflow capability survives cancellation. */
export const isolatedWorkflowExecution = (
  run: string,
  deliver: WorkflowRpc,
  signal: AbortSignal,
): WorkflowExecution => {
  const runId = Schema.decodeUnknownSync(WorkflowRunId)(run);
  const request = (input: typeof WorkflowRpcCommand.Type, callback?: () => Promise<unknown>) =>
    Effect.tryPromise({
      try: () => deliver(input, callback),
      catch: () => new WorkflowFailure({ reason: "engine", retryable: true }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(WorkflowRpcResult)),
      Effect.mapError(() => new WorkflowFailure({ reason: "engine", retryable: true })),
      Effect.flatMap((reply) =>
        reply.ok ? Effect.succeed(reply.value) : Effect.fail(reply.error),
      ),
    );
  return {
    runId,
    driver: {
      do: (name, options, work) =>
        Effect.gen(function* () {
          const services = yield* Effect.context<never>();
          return yield* request({ operation: "do", name, options }, () =>
            Effect.runPromiseWith(services)(
              work().pipe(
                Effect.matchCause({
                  onSuccess: (value) => ({ ok: true as const, value }),
                  onFailure: (cause) => {
                    const error = Cause.squash(cause);
                    return {
                      ok: false as const,
                      error: Schema.is(WorkflowFailure)(error)
                        ? error
                        : new WorkflowFailure({ reason: "execution", retryable: true }),
                    };
                  },
                }),
                Effect.flatMap(Schema.encodeEffect(WorkflowRpcResult)),
              ),
              { signal },
            ),
          );
        }),
      sleep: (name, duration) =>
        request({ operation: "sleep", name, duration }).pipe(Effect.asVoid),
      sleepUntil: (name, timestamp) =>
        request({ operation: "until", name, timestamp }).pipe(Effect.asVoid),
    },
    resolve: () =>
      request({ operation: "context" }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ResolvedAccounts)),
        Effect.map((accounts) => ({ accounts: Redacted.make(accounts) })),
        Effect.mapError((error) =>
          Schema.is(WorkflowFailure)(error)
            ? error
            : new WorkflowFailure({ reason: "credentials", retryable: false }),
        ),
      ),
    invoke: (input) => request({ operation: "invoke", ...input }),
  };
};

/** Reconstruct app-scoped controls from one invocation-owned RPC function. */
export const isolatedWorkflowControls = (
  deliver: (input: unknown) => Promise<unknown>,
): WorkflowHostControls => {
  const request = (input: unknown) =>
    Effect.tryPromise({
      try: () => deliver(input),
      catch: () => new WorkflowFailure({ reason: "engine", retryable: true }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(WorkflowRpcResult)),
      Effect.mapError(() => new WorkflowFailure({ reason: "engine", retryable: true })),
      Effect.flatMap((result) =>
        result.ok ? Effect.succeed(result.value) : Effect.fail(result.error),
      ),
    );
  const run = (input: unknown) =>
    request(input).pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(WorkflowRun)(value).pipe(
          Effect.mapError(() => new WorkflowFailure({ reason: "engine", retryable: true })),
        ),
      ),
    );
  return {
    start: (input) => run({ operation: "start", ...input }),
    get: (input) => run({ operation: "get", ...input }),
    terminate: (input) => run({ operation: "terminate", ...input }),
    list: (input) =>
      request({ operation: "list", ...input }).pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(WorkflowRunPage)(value).pipe(
            Effect.mapError(() => new WorkflowFailure({ reason: "engine", retryable: true })),
          ),
        ),
      ),
  };
};
