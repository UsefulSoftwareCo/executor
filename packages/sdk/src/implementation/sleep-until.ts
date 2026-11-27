import { Clock, Effect } from "effect";
import type { WorkflowFailure } from "apps/contracts";
import { engineCallOf, transientEngineCall } from "../contracts/workflow-errors.ts";

const overOnceTimePassed = (failure: WorkflowFailure) =>
  transientEngineCall(failure) !== undefined || engineCallOf(failure)?.code === "past";

export const untilTime = (
  timestamp: number,
  call: () => Effect.Effect<unknown, WorkflowFailure>,
): Effect.Effect<unknown, WorkflowFailure> =>
  Effect.gen(function* () {
    const passed = Effect.annotateCurrentSpan("executor.workflow.call.passed", true);
    if ((yield* Clock.currentTimeMillis) >= timestamp) return yield* passed;
    return yield* call().pipe(
      Effect.catch((failure) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          now >= timestamp && overOnceTimePassed(failure) ? passed : Effect.fail(failure),
        ),
      ),
    );
  });
