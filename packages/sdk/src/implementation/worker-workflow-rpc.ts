/** Invocation-owned RPC capabilities preserve the Effect context across Dynamic Worker calls. */
import { Cause, Effect, Redacted, Schema, SchemaIssue } from "effect";
import {
  WorkflowInput,
  WorkflowFailure,
  WorkflowRpcCommand,
  WorkflowRpcResult,
  WorkflowControlCommand,
  WorkflowRun,
  WorkflowRunPage,
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
              case "input":
                if (execution.input === undefined)
                  return yield* new WorkflowFailure({ reason: "unavailable", retryable: false });
                return yield* execution
                  .input(command.command)
                  .pipe(Effect.flatMap(Schema.encodeEffect(WorkflowInput)));
              case "input-wait":
                if (execution.driver.waitForInput === undefined)
                  return yield* new WorkflowFailure({ reason: "unavailable", retryable: false });
                return yield* execution.driver
                  .waitForInput(command.name, command.id, command.expiresAt)
                  .pipe(Effect.as(null));
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
const issues = SchemaIssue.makeFormatterStandardSchemaV1();
const controlOperations = ["start", "get", "list", "terminate"] as const;
/**
 * A control call the host refused before it reached the engine. Names each invalid field and the
 * rule it broke; the messages describe the schema, not the value.
 */
const invalidControl = (input: unknown, error: Schema.SchemaError) => {
  const operation =
    typeof input === "object" && input !== null && "operation" in input
      ? controlOperations.find((name) => name === input.operation)
      : undefined;
  const fields = issues(error.issue)
    .issues.slice(0, 4)
    .map(({ path, message }) => {
      const field = (path ?? []).map(String).join(".");
      return `${field === "" ? "input" : field}: ${message.slice(0, 200)}`;
    });
  return new WorkflowFailure({
    reason: "input",
    retryable: false,
    message: `${operation === undefined ? "The workflow call" : `ctx.workflows.${operation}`} was refused before Executor started or changed any run. ${fields.join("; ")}.`,
  });
};
/**
 * App-scoped lifecycle management uses the same private callback transport as step execution.
 * Runs are sent in their encoded form, so apps built before a field's rename read its former name.
 */
export const invocationWorkflowControls = (controls: WorkflowHostControls, signal: AbortSignal) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<never>();
    const run = Schema.encodeEffect(WorkflowRun);
    return (input: unknown): Promise<unknown> =>
      Effect.runPromiseWith(services)(
        reply(
          Effect.gen(function* () {
            const command = yield* Schema.decodeUnknownEffect(WorkflowControlCommand)(input).pipe(
              Effect.mapError((error) => invalidControl(input, error)),
            );
            yield* Effect.annotateCurrentSpan("executor.workflow.operation", command.operation);
            switch (command.operation) {
              case "start":
                return yield* controls.start(command).pipe(Effect.flatMap(run));
              case "get":
                return yield* controls.get(command).pipe(Effect.flatMap(run));
              case "list":
                return yield* controls
                  .list(command)
                  .pipe(Effect.flatMap(Schema.encodeEffect(WorkflowRunPage)));
              case "terminate":
                return yield* controls.terminate(command).pipe(Effect.flatMap(run));
            }
          }).pipe(
            Effect.tapError((error) =>
              Schema.is(WorkflowFailure)(error)
                ? Effect.annotateCurrentSpan({
                    "executor.workflow.failure.reason": error.reason,
                    "executor.workflow.failure.retryable": error.retryable,
                  })
                : Effect.void,
            ),
            Effect.withSpan("workflow.control"),
          ),
        ),
        { signal },
      );
  });
