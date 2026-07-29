import { Effect } from "effect";
import type * as Cause from "effect/Cause";

import type { ExecutionEngine } from "@executor-js/execution";

export const withExecutionUsageTracking = <E extends Cause.YieldableError>(
  organizationId: string,
  engine: ExecutionEngine<E>,
  trackUsage: (organizationId: string) => void,
): ExecutionEngine<E> => ({
  execute: (code, options) =>
    engine
      .execute(code, options)
      .pipe(Effect.tap(() => Effect.sync(() => trackUsage(organizationId)))),
  // `options` MUST be forwarded: it carries `autoApprove`, and dropping it
  // silently turned every auto-approved execution back into a paused one.
  executeWithPause: (code, options) =>
    engine
      .executeWithPause(code, options)
      .pipe(Effect.tap(() => Effect.sync(() => trackUsage(organizationId)))),
  // resume doesn't count as usage
  resume: (executionId, response) => engine.resume(executionId, response),
  isExecutionSettled: engine.isExecutionSettled,
  getPausedExecution: (executionId) => engine.getPausedExecution(executionId),
  pausedExecutionCount: () => engine.pausedExecutionCount(),
  hasPausedExecutions: () => engine.hasPausedExecutions(),
  getDescription: engine.getDescription,
});
