/**
 * A run body's sleeps, repeated when the call to the engine failed in transit.
 *
 * Only a failure the hops classify as transient is repeated (`transientEngineCall`): an internal
 * error or overload the engine reports as passing, a lost connection, or a host that never
 * answered. The engine's own answers pass through at once: an aborted, paused or terminated
 * instance ("Aborting engine: …" from the local engine, `instance.<state>` from Cloudflare's), a
 * refusal, a failure carrying our marker, which the engine relays from the app or the host, and any
 * message no rule recognises. Step calls are never repeated here: the engine names a step by its
 * name and how many times the run called it, so a repeat is a second entry whose work runs again.
 *
 * A repeat sends the same name and duration. The local engine keys a sleep by its name, its
 * duration and how many times the run asked for that pair (`binding.worker.js`, `sleep`). A later
 * replay asks for the first of them. For a `sleep(d)` whose first call failed:
 * - the engine never saw it: the repeat is the first entry, which a replay finds. No extra wait.
 * - the engine recorded it and the answer was lost at `t` before `d`: the repeat waits `d` as a
 *   second entry; a replay finds the first. Up to `t` extra.
 * - the answer was lost after `d`: the failed call lasted `d`, so the sleep is over and is not
 *   repeated (below). No extra wait.
 * - the engine counted the call but failed before writing its entry: the repeat waits `d` as a
 *   second entry, and a later replay finds no first entry and waits `d` again. Up to `d` extra,
 *   once, on that replay. The run wakes late, never early.
 *
 * A repeat would wait the whole duration again after an engine that did wait and lost only its
 * answer. So a `sleep` whose failed call itself lasted the duration is over instead of repeated:
 * only an engine holding the call for the sleep makes it last that long.
 *
 * Nothing bounds a call itself: a sleep's call lasts as long as the sleep. Cancellation interrupts
 * it, and the waits between calls, at once: the call runs in the RPC handler's fiber, which the
 * invocation's signal interrupts (`invocationWorkflow`).
 */
import { Clock, Effect, Random, Result } from "effect";
import { WorkflowFailure } from "apps/contracts";
import { engineCallOf, transientEngineCall } from "../contracts/workflow-errors.ts";

/** Calls a sleep gets in all: the first and three repeats. */
export const sleepAttempts = 4;
/** The wait before the first repeat. Each later wait doubles; each is jittered to 80-120%. */
export const firstRepeatMillis = 200;

/** The authored name inside the engine's step name, `<kind>:<name>:<64 hex digits>`. */
const authoredName = (name: string) => /^[a-z]+:([\s\S]*):[0-9a-f]{64}$/.exec(name)?.[1] ?? name;

/** What the run's owner reads when every call failed: the hops' own words, no platform text. */
const exhausted = (
  kind: "sleep" | "until",
  name: string,
  attempts: number,
  last: NonNullable<ReturnType<typeof engineCallOf>>,
) =>
  new WorkflowFailure({
    reason: "engine",
    retryable: true,
    step: authoredName(name).slice(0, 200),
    errorName: "WorkflowEngineCallFailed",
    message: `Executor called the workflow engine ${attempts} times for this ${
      kind === "sleep" ? "sleep" : "sleepUntil"
    } and every call failed. The last failure: hop=${last.hop}; class=${last.errorClass}; code=${last.code}.`,
  });

/**
 * One sleep from the run body, with its own span. `durationMillis` is a `sleep`'s duration; a
 * `sleepUntil` passes none, as its own check ends it once its time has passed (`sleep-until.ts`).
 */
export const repeatedSleep = (
  run: string,
  kind: "sleep" | "until",
  name: string,
  call: () => Effect.Effect<unknown, WorkflowFailure>,
  durationMillis: number | undefined,
) =>
  Effect.gen(function* () {
    let attempts = 0;
    let wait = firstRepeatMillis;
    for (;;) {
      attempts += 1;
      const called = yield* Clock.currentTimeMillis;
      const result = yield* Effect.result(call());
      if (Result.isSuccess(result)) {
        yield* Effect.annotateCurrentSpan("executor.workflow.call.attempts", attempts);
        return null;
      }
      const failure = result.failure;
      const transient = transientEngineCall(failure);
      const failed = engineCallOf(failure);
      // A call that failed only after lasting the whole sleep was held by an engine that waited
      // it and lost only its answer: the sleep is over, and the engine has its entry.
      const waited =
        durationMillis !== undefined && (yield* Clock.currentTimeMillis) - called >= durationMillis;
      if (transient !== undefined && waited) {
        yield* Effect.annotateCurrentSpan({
          "executor.workflow.call.attempts": attempts,
          "executor.workflow.call.waited": true,
        });
        return null;
      }
      if (transient === undefined || attempts >= sleepAttempts) {
        yield* Effect.annotateCurrentSpan({
          "executor.workflow.call.attempts": attempts,
          "executor.workflow.call.outcome": transient === undefined ? "refused" : "failed",
          ...(failed === undefined
            ? {}
            : {
                "executor.workflow.call.hop": failed.hop,
                "executor.workflow.call.error_class": failed.errorClass,
                "executor.workflow.call.code": failed.code,
              }),
        });
        return yield* transient === undefined || attempts === 1
          ? Effect.fail(failure)
          : Effect.fail(exhausted(kind, name, attempts, transient));
      }
      const jittered = Math.round(wait * (0.8 + 0.4 * (yield* Random.next)));
      // The repeat's own facts: what failed, and the wait the product scheduled before it.
      yield* Effect.annotateCurrentSpan({
        [`executor.workflow.call.repeat_${attempts}.hop`]: transient.hop,
        [`executor.workflow.call.repeat_${attempts}.code`]: transient.code,
        [`executor.workflow.call.repeat_${attempts}.wait_ms`]: jittered,
      });
      yield* Effect.sleep(jittered);
      wait *= 2;
    }
  }).pipe(
    Effect.withSpan(kind === "sleep" ? "workflow.sleep" : "workflow.sleepUntil", {
      attributes: { "executor.run.id": run, "executor.workflow.step": name },
    }),
  );
