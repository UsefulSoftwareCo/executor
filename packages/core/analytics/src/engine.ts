// ---------------------------------------------------------------------------
// Execution-analytics engine wrapper.
//
// The same overlay shape as cloud's `withExecutionUsageTracking` billing
// decorator: wrap the engine once per serving plane, at the composition root.
// Because the wrap point IS the plane, the `plane` label is bound structurally
// — misattribution is impossible the way it would be with a header or flag.
//
// Outcome semantics: one `execution_completed` per execution reaching a
// terminal state. A sandbox-level failure lands on the success channel as
// `ExecuteResult.error`; an infrastructure failure lands on the Effect error
// channel. Both count as `ok: false`. A pause is not terminal — the execution
// is recorded when its resume completes, so approve-then-complete counts once.
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import type * as Cause from "effect/Cause";

import type { ExecutionEngine, ExecutionResult } from "@executor-js/execution";

import type { AnalyticsService } from "./analytics";
import type { ExecutionPlane } from "./events";

export interface ExecutionAnalyticsContext {
  readonly plane: ExecutionPlane;
  /** Whether this engine serves a toolkit-scoped endpoint. */
  readonly toolkit: boolean;
}

export const withExecutionAnalytics = <E extends Cause.YieldableError>(
  engine: ExecutionEngine<E>,
  analytics: AnalyticsService,
  context: ExecutionAnalyticsContext,
): ExecutionEngine<E> => {
  const completed = (ok: boolean): Effect.Effect<void> =>
    analytics.record("execution_completed", {
      ok,
      plane: context.plane,
      toolkit: context.toolkit,
    });

  const recordOutcome = (result: ExecutionResult | null): Effect.Effect<void> =>
    result?.status === "completed" ? completed(!result.result.error) : Effect.void;

  return {
    ...engine,
    execute: (code, options) =>
      engine.execute(code, options).pipe(
        Effect.tap((result) => completed(!result.error)),
        Effect.tapError(() => completed(false)),
      ),
    executeWithPause: (code, options) =>
      engine.executeWithPause(code, options).pipe(
        Effect.tap(recordOutcome),
        Effect.tapError(() => completed(false)),
      ),
    resume: (executionId, response) =>
      engine.resume(executionId, response).pipe(
        Effect.tap(recordOutcome),
        Effect.tapError(() => completed(false)),
      ),
  };
};
