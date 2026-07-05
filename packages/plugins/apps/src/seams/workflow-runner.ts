import type { Effect } from "effect";
import { Data } from "effect";

// ---------------------------------------------------------------------------
// WorkflowRunner — durable workflow execution with an event-sourced journal.
//
// Cloudflare Workflows semantics verbatim: `step.do(name, fn)` memoized by the
// journal, `step.sleep`, `step.waitForEvent`, plus executor's `step.tool`
// (journal + audit in one). Kill mid-step -> restart -> completed steps do NOT
// re-execute (replay reads the journal). The self-hosted backing is a SQLite
// journal replay runner + in-process scheduler; the cloud backing (future) is
// CF Workflows + dynamic-workflows. The journal shape is modeled on
// vercel/workflow's World Storage contract (append-only events, materialized
// run/step views).
//
// The runner is substrate-neutral: it takes a `StepExecutor` (how to run a
// named step body / tool call for THIS run) so the sandbox/tool wiring stays
// outside the durable core. Runs pin the snapshot that started them.
// ---------------------------------------------------------------------------

export class WorkflowError extends Data.TaggedError("WorkflowError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type RunStatus = "running" | "sleeping" | "waiting" | "completed" | "failed" | "cancelled";

export interface RunView {
  readonly runId: string;
  readonly scope: string;
  readonly workflow: string;
  readonly snapshotId: string;
  readonly status: RunStatus;
  readonly input: unknown;
  readonly output?: unknown;
  readonly error?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type StepStatus = "completed" | "failed";

export interface StepView {
  readonly runId: string;
  readonly name: string;
  readonly status: StepStatus;
  readonly output?: unknown;
  readonly error?: string;
  readonly attempt: number;
  readonly completedAt: number;
}

/** How the runner executes step bodies for a specific run. The durable core
 *  drives this; the caller supplies it (bound to the run's snapshot + scope +
 *  the tool invoke path). Each method is only ever called for a step that has
 *  NOT completed in the journal (the runner checks the journal first). */
export interface StepExecutor {
  /** Run a `step.do` body identified by name; return its JSON result. */
  readonly runStep: (name: string) => Effect.Effect<unknown, WorkflowError>;
  /** Run a `step.tool` call (address + args); return the tool's JSON result.
   *  Journaled AND audited as a tool run by the caller's implementation. */
  readonly runTool: (
    name: string,
    address: string,
    args: unknown,
  ) => Effect.Effect<unknown, WorkflowError>;
  /** Deliver a `step.notify`. */
  readonly notify: (msg: {
    readonly title: string;
    readonly body?: string;
    readonly link?: string;
  }) => Effect.Effect<void, WorkflowError>;
}

/** The workflow body, expressed against the durable step API. The runner
 *  replays it: completed steps resolve from the journal, the first incomplete
 *  step actually executes. `sleep`/`waitForEvent` suspend the run. */
export interface DurableSteps {
  readonly do: <T>(name: string, fn: () => Promise<T> | T) => Promise<T>;
  readonly tool: <T = unknown>(address: string, args: Record<string, unknown>) => Promise<T>;
  readonly sleep: (name: string, ms: number) => Promise<void>;
  readonly waitForEvent: <T = unknown>(name: string, opts?: { timeout?: number }) => Promise<T>;
  readonly notify: (msg: { title: string; body?: string; link?: string }) => Promise<void>;
}

export interface StartRunInput {
  readonly scope: string;
  readonly workflow: string;
  readonly snapshotId: string;
  readonly input: unknown;
  /** Optional caller-supplied run id (idempotent starts / scheduler dedupe). */
  readonly runId?: string;
}

/**
 * The durable runner. `start` creates a run and drives it to its first
 * suspension or completion. `resume` re-drives a suspended/interrupted run from
 * the journal (this is what makes the kill test pass: completed steps replay
 * from the journal and never re-execute). `signal` delivers a waitForEvent
 * payload. `get`/`listSteps` are the queryable status/history.
 *
 * `run` is the workflow body supplied by the caller (bound to the snapshot's
 * compiled bundle via `execute`). The runner calls it with a `DurableSteps`
 * that consults the journal.
 */
export interface WorkflowRunner {
  readonly start: (
    input: StartRunInput,
    execute: (steps: DurableSteps) => Promise<unknown>,
  ) => Effect.Effect<RunView, WorkflowError>;
  readonly resume: (
    runId: string,
    execute: (steps: DurableSteps) => Promise<unknown>,
  ) => Effect.Effect<RunView, WorkflowError>;
  readonly signal: (
    runId: string,
    eventName: string,
    payload: unknown,
    execute: (steps: DurableSteps) => Promise<unknown>,
  ) => Effect.Effect<RunView, WorkflowError>;
  readonly cancel: (runId: string) => Effect.Effect<RunView, WorkflowError>;
  readonly get: (runId: string) => Effect.Effect<RunView | null, WorkflowError>;
  readonly list: (filter?: {
    readonly scope?: string;
    readonly workflow?: string;
  }) => Effect.Effect<readonly RunView[], WorkflowError>;
  readonly listSteps: (runId: string) => Effect.Effect<readonly StepView[], WorkflowError>;
  readonly close: () => Effect.Effect<void, WorkflowError>;
}

/** Control errors that steer retry/replay, matching CF's vocabulary. */
export class FatalError extends Data.TaggedError("FatalError")<{
  readonly message: string;
}> {}

export class RetryableError extends Data.TaggedError("RetryableError")<{
  readonly message: string;
  readonly retryAfter?: number;
}> {}
