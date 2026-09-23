/** Author-facing step methods delegate persistence to the host's durable engine. */
import { Cause, Effect, Schema } from "effect";
import type { AppDefinition } from "../contracts/app.ts";
import {
  NonRetryableError,
  WorkflowFailure,
  WorkflowName,
  WorkflowStepOptions,
  WorkflowValue,
  WorkflowDuration,
  workflowDurationMillis,
  type WorkflowContext,
  type WorkflowExecution,
  type WorkflowStepContext,
} from "../contracts/workflows.ts";
import { JsonValue } from "../contracts/schema.ts";
import { nativeOperation } from "./operations.ts";
import { toPromise } from "./authoring.ts";

/** Preserve typed failures and cancellation; authored exception text never leaves the app. */
export const workflowSafe = <A>(
  work: Effect.Effect<A, unknown>,
): Effect.Effect<A, WorkflowFailure> =>
  work.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.interrupt;
      const error = Cause.squash(cause);
      if (Schema.is(WorkflowFailure)(error)) return Effect.fail(error);
      return Effect.fail(
        new WorkflowFailure({
          reason: "execution",
          retryable: !(error instanceof NonRetryableError),
        }),
      );
    }),
  );

/** Construct one replay's Promise context. Step callbacks acquire fresh capabilities per actual attempt. */
export const makeWorkflowContext = (
  execution: WorkflowExecution,
  definition: Pick<AppDefinition<never>, "queries" | "mutations">,
  fresh: (
    stepId: string,
    signal: AbortSignal,
  ) => Effect.Effect<WorkflowStepContext, WorkflowFailure>,
  signal: AbortSignal,
): Effect.Effect<WorkflowContext> =>
  Effect.gen(function* () {
    const services = yield* Effect.context<never>();
    const counts = new Map<string, number>();
    const identify = (kind: string, name: string) =>
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(WorkflowName)(name).pipe(
          Effect.mapError(() => new WorkflowFailure({ reason: "input", retryable: false })),
        );
        const key = JSON.stringify([kind, name]);
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        const digest = yield* Effect.tryPromise({
          try: () =>
            crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(JSON.stringify([execution.runId, kind, name, count])),
            ),
          catch: () => new WorkflowFailure({ reason: "execution", retryable: false }),
        });
        return Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
      });
    // Mirror the native step deadline so a timed-out attempt releases its own capabilities.
    const attempt = <A>(options: WorkflowStepOptions, work: Effect.Effect<A, WorkflowFailure>) => {
      const timeout = workflowDurationMillis(options.timeout ?? "10 minutes");
      if (timeout === undefined)
        return Effect.fail(new WorkflowFailure({ reason: "input", retryable: false }));
      return work.pipe(
        Effect.timeout(timeout),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(new WorkflowFailure({ reason: "execution", retryable: true })),
        ),
      );
    };
    const runStep = (
      name: string,
      options: WorkflowStepOptions,
      callback: (ctx: WorkflowStepContext) => Promise<unknown>,
    ) =>
      Effect.gen(function* () {
        const stepId = yield* identify("do", name);
        const parsed = yield* Schema.decodeUnknownEffect(WorkflowStepOptions)(options).pipe(
          Effect.mapError(() => new WorkflowFailure({ reason: "input", retryable: false })),
        );
        return yield* execution.driver.do(`do:${name.slice(0, 100)}:${stepId}`, parsed, () =>
          attempt(
            parsed,
            Effect.scoped(
              Effect.gen(function* () {
                const controller = yield* Effect.acquireRelease(
                  Effect.sync(() => new AbortController()),
                  (controller) => Effect.sync(() => controller.abort()),
                );
                const ctx = yield* fresh(stepId, AbortSignal.any([signal, controller.signal]));
                const result = yield* workflowSafe(
                  Effect.tryPromise({ try: () => callback(ctx), catch: (error) => error }),
                );
                return yield* Schema.decodeUnknownEffect(WorkflowValue)(result).pipe(
                  Effect.mapError(
                    () => new WorkflowFailure({ reason: "output", retryable: false }),
                  ),
                );
              }),
            ).pipe(Effect.provideContext(services)),
          ),
        );
      });
    const operationStep = (
      kind: "query" | "mutation",
      name: string,
      operation: unknown,
      input: unknown,
      options: WorkflowStepOptions,
    ) =>
      Effect.gen(function* () {
        const target = nativeOperation(operation);
        const catalog = kind === "query" ? definition.queries : definition.mutations;
        const match = Object.entries(catalog ?? {}).find(
          ([, value]) => value === target && value.kind === kind,
        );
        if (target === undefined || match === undefined)
          return yield* new WorkflowFailure({ reason: "operation", retryable: false });
        const args = yield* Schema.decodeUnknownEffect(JsonValue)(input).pipe(
          Effect.mapError(() => new WorkflowFailure({ reason: "input", retryable: false })),
        );
        const parsed = yield* Schema.decodeUnknownEffect(WorkflowStepOptions)(options).pipe(
          Effect.mapError(() => new WorkflowFailure({ reason: "input", retryable: false })),
        );
        const stepId = yield* identify(kind, name);
        const timeout = workflowDurationMillis(parsed.timeout ?? "10 minutes");
        if (timeout === undefined)
          return yield* new WorkflowFailure({ reason: "input", retryable: false });
        return yield* execution.driver.do(`${kind}:${name.slice(0, 100)}:${stepId}`, parsed, () =>
          attempt(
            parsed,
            execution
              .invoke({ kind, name: match[0], input: args, stepId, timeout })
              .pipe(Effect.provideContext(services)),
          ),
        );
      });
    const invoke = <A>(effect: Effect.Effect<A, WorkflowFailure>) =>
      toPromise(() => effect.pipe(Effect.provideContext(services)), signal)();
    // SAFETY: nativeOperation pairs each registered input/output with its decoder. The driver
    // returns the same JSON-validated callback result on execution and replay of pinned code.
    const step: WorkflowContext["step"] = {
      do: (
        name: string,
        options: WorkflowStepOptions | ((ctx: WorkflowStepContext) => Promise<unknown>),
        run?: (ctx: WorkflowStepContext) => Promise<unknown>,
      ) => {
        const callback = typeof options === "function" ? options : run;
        if (callback === undefined)
          return Promise.reject(new WorkflowFailure({ reason: "input", retryable: false }));
        return invoke(runStep(name, typeof options === "function" ? {} : options, callback));
      },
      runQuery: (name, operation, input, options = {}) =>
        invoke(operationStep("query", name, operation, input, options)),
      runMutation: (name, operation, input, options = {}) =>
        invoke(operationStep("mutation", name, operation, input, options)),
      sleep: (name, duration) =>
        invoke(
          Schema.decodeUnknownEffect(WorkflowDuration)(duration).pipe(
            Effect.mapError(() => new WorkflowFailure({ reason: "input", retryable: false })),
            Effect.flatMap((parsed) =>
              identify("sleep", name).pipe(
                Effect.flatMap((id) =>
                  execution.driver.sleep(`sleep:${name.slice(0, 100)}:${id}`, parsed),
                ),
              ),
            ),
          ),
        ),
      sleepUntil: (name, timestamp) =>
        invoke(
          identify("until", name).pipe(
            Effect.flatMap((id) =>
              execution.driver.sleepUntil(
                `until:${name.slice(0, 100)}:${id}`,
                timestamp instanceof Date ? timestamp.getTime() : timestamp,
              ),
            ),
          ),
        ),
    } as WorkflowContext["step"];
    return { runId: execution.runId, step };
  });
