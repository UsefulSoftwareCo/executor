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
  executeWithPause: (code) =>
    engine
      .executeWithPause(code)
      .pipe(Effect.tap(() => Effect.sync(() => trackUsage(organizationId)))),
  // resume doesn't count as usage
  resume: (executionId, response) => engine.resume(executionId, response),
  getPausedExecution: (executionId) => engine.getPausedExecution(executionId),
  getDescription: engine.getDescription,
});
