/** The executor's client for the native app workflow: start, inspect and stop runs. */
import * as Cloudflare from "alchemy/Cloudflare";
import type { Workflow } from "@cloudflare/workers-types";
import { Cause, Effect, Result, Schema } from "effect";
import {
  WorkflowBackendState,
  type WorkflowRuntime,
  type WorkflowRunId,
  WorkflowFailure,
  decodeWorkflowFailure,
} from "@executor-js/sdk/core";
import { readNativeWorkflowStatus } from "../implementation/workflow-status.ts";
import { providerFailureCode } from "../implementation/provider-failure.ts";
import {
  encryptedWorkflowParams,
  encryptedWorkflowInstance,
  workflowEncryptionKey,
  workflowEncryptionEnabled,
  workflowResults,
} from "./workflow-results.ts";

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
  (
    value,
  ): value is Pick<
    Workflow<{ run: string } | { __executorWorkflowResults: 1; params: { run: string } }>,
    "get" | "create"
  > =>
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
export const cloudWorkflows = Effect.gen(function* () {
  const environment = yield* Cloudflare.WorkerEnvironment;
  const encryptionKey = yield* workflowEncryptionKey;
  const encryptedStarts = yield* workflowEncryptionEnabled;
  // Resolve native handles only during invocation, after Alchemy has installed bindings.
  const binding = Effect.suspend(() =>
    Schema.decodeUnknownEffect(NativeWorkflow)(environment.AppWorkflows),
  ).pipe(Effect.mapError(failure));
  const read = (instance: string) =>
    binding.pipe(
      Effect.flatMap((binding) =>
        readNativeWorkflowStatus(async () => (await binding.get(instance)).status()).pipe(
          Effect.tapError((error) =>
            Effect.annotateCurrentSpan({
              "executor.workflow.failure.phase": "native_status",
              "executor.workflow.failure.code": providerFailureCode(error),
            }),
          ),
        ),
      ),
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        if (error instanceof Error && error.message.includes("instance.not_found"))
          return Effect.succeed({ status: "unknown" } as const);
        return Effect.failCause(cause);
      }),
    );
  // An instance's identity fixes its journal format, so a retyped output cannot downgrade it.
  // Existing unprefixed instances keep their legacy output and do not restart under a new id.
  const locate = (run: WorkflowRunId) =>
    Effect.gen(function* () {
      const encryptedInstance = encryptedWorkflowInstance(run);
      const current = yield* read(encryptedInstance);
      const encrypted = current.status !== "unknown";
      const instance = encrypted ? encryptedInstance : run;
      const value = encrypted ? current : yield* read(run);
      if (value.status === "unknown") return { instance, state: { status: "missing" } as const };
      const state = yield* Effect.gen(function* () {
        if (value.status !== "complete")
          return yield* Schema.decodeUnknownEffect(WorkflowBackendState)(value);
        const output = encrypted
          ? yield* workflowResults(run, encryptionKey).pipe(
              Effect.flatMap((results) => results.openWorkflowOutput(value.output)),
            )
          : value.output;
        return yield* Schema.decodeUnknownEffect(WorkflowBackendState)({
          status: "complete",
          output,
        });
      }).pipe(
        Effect.tapError(() =>
          Effect.annotateCurrentSpan({
            "executor.workflow.failure.phase": "decode_status",
            "executor.workflow.backend.status": value.status,
          }),
        ),
      );
      return { instance, state };
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(recover(Cause.squash(cause))),
      ),
      Effect.tapError((error) =>
        Effect.annotateCurrentSpan({
          "executor.workflow.failure.reason": error.reason,
          "executor.workflow.failure.retryable": error.retryable,
        }),
      ),
      Effect.withSpan("workflow.backend.status", { attributes: { "executor.run.id": run } }),
    );
  const status: WorkflowRuntime["status"] = (run) =>
    locate(run).pipe(Effect.map(({ state }) => state));
  return {
    status,
    start: (run) =>
      Effect.gen(function* () {
        if ((yield* status(run)).status !== "missing") return;
        const namespace = yield* binding;
        const created = yield* safe(
          native(() =>
            namespace.create({
              id: encryptedStarts ? encryptedWorkflowInstance(run) : run,
              params: encryptedWorkflowParams({ run }, encryptedStarts),
            }),
          ),
        ).pipe(Effect.result);
        if (Result.isFailure(created) && (yield* status(run)).status === "missing")
          return yield* created.failure;
      }),
    terminate: (run) =>
      Effect.gen(function* () {
        const finished = (state: WorkflowBackendState) =>
          ["missing", "complete", "errored", "terminated"].includes(state.status);
        const located = yield* locate(run);
        if (finished(located.state)) return;
        const namespace = yield* binding;
        const terminated = yield* safe(
          native(async () => (await namespace.get(located.instance)).terminate()),
        ).pipe(Effect.result);
        // The run can finish between the status read and the native call, which then refuses
        // to terminate the finished instance. Only a run that is still active failed to stop.
        if (Result.isFailure(terminated) && !finished(yield* status(run)))
          return yield* terminated.failure;
      }),
  } satisfies WorkflowRuntime;
});
