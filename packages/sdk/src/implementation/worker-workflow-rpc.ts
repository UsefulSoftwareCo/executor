/** Invocation-owned RPC capabilities preserve the Effect context across Dynamic Worker calls. */
import { Cause, Effect, Redacted, Schema } from "effect";
import {
  WorkflowFailure,
  WorkflowRpcCommand,
  WorkflowRpcResult,
  WorkflowControlCommand,
  type WorkflowExecution,
  type WorkflowHostControls,
  type WorkflowRpc,
} from "apps/contracts";

const reply = <A>(effect: Effect.Effect<A, unknown>) =>
  effect.pipe(
    Effect.matchCause({
      onSuccess: (value) => ({ ok: true as const, value }),
      onFailure: (cause) => {
        const error = Cause.squash(cause);
        return {
          ok: false as const,
          error: Schema.is(WorkflowFailure)(error)
            ? error
            : new WorkflowFailure({ reason: "engine", retryable: true }),
        };
      },
    }),
    Effect.flatMap(Schema.encodeUnknownEffect(WorkflowRpcResult)),
  );
/** A run's step dispatcher cannot change its run or app identity. */
export const invocationWorkflow = (
  execution: WorkflowExecution,
  signal: AbortSignal,
): Effect.Effect<WorkflowRpc> =>
  Effect.gen(function* () {
    const services = yield* Effect.context<never>();
    return (input, callback) =>
      Effect.runPromiseWith(services)(
        reply(
          Effect.gen(function* () {
            const command = yield* Schema.decodeUnknownEffect(WorkflowRpcCommand)(input);
            switch (command.operation) {
              case "do": {
                if (callback === undefined)
                  return yield* new WorkflowFailure({ reason: "input", retryable: false });
                return yield* execution.driver.do(command.name, command.options, () =>
                  Effect.tryPromise({
                    try: () => callback(),
                    catch: () => new WorkflowFailure({ reason: "engine", retryable: true }),
                  }).pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(WorkflowRpcResult)),
                    Effect.mapError(
                      () => new WorkflowFailure({ reason: "engine", retryable: true }),
                    ),
                    Effect.flatMap((result) =>
                      result.ok ? Effect.succeed(result.value) : Effect.fail(result.error),
                    ),
                  ),
                );
              }
              case "sleep":
                return yield* execution.driver
                  .sleep(command.name, command.duration)
                  .pipe(Effect.as(null));
              case "until":
                return yield* execution.driver
                  .sleepUntil(command.name, command.timestamp)
                  .pipe(Effect.as(null));
              case "context": {
                const context = yield* execution.resolve();
                return Redacted.value(context.accounts);
              }
              case "invoke":
                // RPC Promise cancellation cannot interrupt its remote callee. Apply
                // the attempt deadline on the host that owns the storage transaction.
                return yield* execution.invoke(command).pipe(
                  Effect.timeout(command.timeout),
                  Effect.catchTag("TimeoutError", () =>
                    Effect.fail(new WorkflowFailure({ reason: "engine", retryable: true })),
                  ),
                );
            }
          }),
        ),
        { signal },
      );
  });
/** App-scoped lifecycle management uses the same private callback transport as step execution. */
export const invocationWorkflowControls = (controls: WorkflowHostControls, signal: AbortSignal) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<never>();
    return (input: unknown): Promise<unknown> =>
      Effect.runPromiseWith(services)(
        reply(
          Effect.gen(function* () {
            const command = yield* Schema.decodeUnknownEffect(WorkflowControlCommand)(input);
            switch (command.operation) {
              case "start":
                return yield* controls.start(command);
              case "get":
                return yield* controls.get(command);
              case "list":
                return yield* controls.list(command);
              case "terminate":
                return yield* controls.terminate(command);
            }
          }),
        ),
        { signal },
      );
  });
