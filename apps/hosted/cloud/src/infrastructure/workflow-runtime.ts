/** The executor's client for the native app workflow: start, inspect and stop runs. */
import * as Cloudflare from "alchemy/Cloudflare";
import type { Workflow } from "@cloudflare/workers-types";
import { Cause, Effect, Result, Schema } from "effect";
import {
  WorkflowBackendState,
  type WorkflowRuntime,
  WorkflowFailure,
  decodeWorkflowFailure,
} from "@executor-js/sdk/core";
import { readNativeWorkflowStatus } from "../implementation/workflow-status.ts";
import { providerFailureCode } from "../implementation/provider-failure.ts";

const failure = () => new WorkflowFailure({ reason: "engine", retryable: true });
const recover = decodeWorkflowFailure;
/** Settle a native engine call as the workflow failure it reports. */
export const safe = <A, R>(
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, WorkflowFailure, R> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(recover(Cause.squash(cause))),
    ),
  );

const NativeWorkflow = Schema.declare(
  (value): value is Pick<Workflow<{ run: string }>, "get" | "create"> =>
    typeof value === "object" &&
    value !== null &&
    "get" in value &&
    typeof value.get === "function" &&
    "create" in value &&
    typeof value.create === "function",
);
const native = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: (error) => error });

/** Use the API-owned binding. App-page Workers bind the same workflow through their env. */
export const cloudWorkflows: Effect.Effect<WorkflowRuntime, never, Cloudflare.WorkerEnvironment> =
  Effect.gen(function* () {
    const environment = yield* Cloudflare.WorkerEnvironment;
    // Resolve native handles only during invocation, after Alchemy has installed bindings.
    const binding = Effect.suspend(() =>
      Schema.decodeUnknownEffect(NativeWorkflow)(environment.AppWorkflows),
    ).pipe(Effect.mapError(failure));
    const status: WorkflowRuntime["status"] = (run) =>
      binding.pipe(
        Effect.flatMap((binding) =>
          readNativeWorkflowStatus(async () => (await binding.get(run)).status()).pipe(
            Effect.tapError((error) =>
              Effect.annotateCurrentSpan({
                "executor.workflow.failure.phase": "native_status",
                "executor.workflow.failure.code": providerFailureCode(error),
              }),
            ),
          ),
        ),
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(WorkflowBackendState)(
            value.status === "unknown" ? { status: "missing" } : value,
          ).pipe(
            Effect.tapError(() =>
              Effect.annotateCurrentSpan({
                "executor.workflow.failure.phase": "decode_status",
                "executor.workflow.backend.status": value.status,
              }),
            ),
          ),
        ),
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause);
          if (error instanceof Error && error.message.includes("instance.not_found"))
            return Effect.succeed({ status: "missing" } as const);
          return Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(recover(error));
        }),
        Effect.tapError((error) =>
          Effect.annotateCurrentSpan({
            "executor.workflow.failure.reason": error.reason,
            "executor.workflow.failure.retryable": error.retryable,
          }),
        ),
        Effect.withSpan("workflow.backend.status", { attributes: { "executor.run.id": run } }),
      );
    return {
      status,
      start: (run) =>
        Effect.gen(function* () {
          if ((yield* status(run)).status !== "missing") return;
          const namespace = yield* binding;
          const created = yield* safe(
            native(() => namespace.create({ id: run, params: { run } })),
          ).pipe(Effect.result);
          if (Result.isFailure(created) && (yield* status(run)).status === "missing")
            return yield* created.failure;
        }),
      terminate: (run) =>
        Effect.gen(function* () {
          const finished = (state: WorkflowBackendState) =>
            ["missing", "complete", "errored", "terminated"].includes(state.status);
          if (finished(yield* status(run))) return;
          const namespace = yield* binding;
          const terminated = yield* safe(
            native(async () => (await namespace.get(run)).terminate()),
          ).pipe(Effect.result);
          // The run can finish between the status read and the native call, which then refuses
          // to terminate the finished instance. Only a run that is still active failed to stop.
          if (Result.isFailure(terminated) && !finished(yield* status(run)))
            return yield* terminated.failure;
        }),
    } satisfies WorkflowRuntime;
  });
