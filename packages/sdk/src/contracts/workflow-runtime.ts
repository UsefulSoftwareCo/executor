/** Hosts supply durable orchestration independently of app code execution and product authorization. */
import { Schema, type Effect } from "effect";
import {
  WorkflowRunId,
  WorkflowFailure,
  WorkflowValue,
  type WorkflowDriver,
  type HostContext,
  type WorkflowRun,
} from "apps/contracts";
import { AppId, BuildId, DeploymentId } from "./shared.ts";

/** Backend inspection is parsed before it affects a retained run. */
export const WorkflowBackendState = Schema.Union([
  Schema.Struct({
    status: Schema.Literals([
      "queued",
      "running",
      "waiting",
      "paused",
      "waitingForPause",
      "terminated",
      "missing",
    ]),
  }),
  Schema.Struct({ status: Schema.Literal("complete"), output: WorkflowValue }),
  Schema.Struct({ status: Schema.Literal("errored") }),
]);
export type WorkflowBackendState = typeof WorkflowBackendState.Type;
/** All methods are idempotent for a run ID. Backends persist timers and checkpoints. */
export interface WorkflowRuntime {
  readonly start: (run: WorkflowRunId) => Effect.Effect<void, WorkflowFailure>;
  readonly status: (run: WorkflowRunId) => Effect.Effect<WorkflowBackendState, WorkflowFailure>;
  readonly terminate: (run: WorkflowRunId) => Effect.Effect<void, WorkflowFailure>;
}
/** Source metadata is private to the host; no credential values enter engine parameters. */
export const WorkflowSeed = Schema.Struct({
  runId: WorkflowRunId,
  app: AppId,
  build: BuildId,
  deployment: DeploymentId,
  name: Schema.NonEmptyString,
  input: WorkflowValue,
});
export type WorkflowSeed = typeof WorkflowSeed.Type;
/** Background execution uses host-only capabilities, outside the public HTTP/Promise facade. */
export const WorkflowHost = Symbol("executor.WorkflowHost");
/** Execution callbacks acquire fresh account/storage authority on every step. */
export interface WorkflowHost {
  /** Read retained state without reopening accounts or consulting the backend. */
  readonly get: (run: WorkflowRunId) => Effect.Effect<WorkflowRun, WorkflowFailure>;
  readonly seed: (run: WorkflowRunId) => Effect.Effect<WorkflowSeed, WorkflowFailure>;
  readonly context: (
    run: WorkflowRunId,
  ) => Effect.Effect<HostContext & { readonly database: boolean }, WorkflowFailure>;
  readonly invoke: (
    run: WorkflowRunId,
    input: {
      readonly kind: "query" | "mutation";
      readonly name: string;
      readonly input: typeof WorkflowValue.Type;
      readonly stepId: string;
    },
  ) => Effect.Effect<typeof WorkflowValue.Type, WorkflowFailure>;
  readonly execute: (
    run: WorkflowRunId,
    driver: WorkflowDriver,
  ) => Effect.Effect<typeof WorkflowValue.Type, WorkflowFailure>;
  readonly finish: (
    run: WorkflowRunId,
    result:
      | { readonly ok: true; readonly output: typeof WorkflowValue.Type }
      | { readonly ok: false; readonly error: WorkflowFailure["reason"] },
  ) => Effect.Effect<void, WorkflowFailure>;
  readonly reconcile: Effect.Effect<void, WorkflowFailure>;
}
export type { WorkflowDriver };
