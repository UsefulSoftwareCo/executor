/**
 * A run's `sleepUntil` a time that has passed is over: the run goes on without asking the engine.
 *
 * The engine refuses a `sleepUntil` whose time is in the past ("You can't sleep until a time in
 * the past", miniflare's `binding.worker.js`, the engine Cloudflare ships for local runs). A body
 * that computes its time and then reaches the engine late, or whose first call failed and is
 * repeated after the time, would otherwise fail its run for waiting too little. Skipping the call
 * is the same on a replay: the time has passed then too, and each call has its own engine name.
 */
import { Clock, Effect } from "effect";
import type { WorkflowFailure } from "apps/contracts";
import { engineCallOf, transientEngineCall } from "../contracts/workflow-errors.ts";

/**
 * Whether a failed call's time having passed ends the sleep: only for a failure in transit
 * (`transientEngineCall`, the one classification of what is transient) or the engine's refusal of a
 * time in the past. Any other failure is the engine's answer, such as a pause or a termination that
 * arrives as the wait ends, and reaches the body as it would from a `sleep`.
 */
const overOnceTimePassed = (failure: WorkflowFailure) =>
  transientEngineCall(failure) !== undefined || engineCallOf(failure)?.code === "past";

/** Call the engine only while `timestamp` is ahead; see `overOnceTimePassed` for a failed call. */
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
