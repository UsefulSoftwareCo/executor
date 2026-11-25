import { Clock, Effect, Random, Result } from "effect";
import { WorkflowFailure } from "apps/contracts";
import { engineCallOf, transientEngineCall } from "../contracts/workflow-errors.ts";

export const sleepAttempts = 4;
export const firstRepeatMillis = 200;

const authoredName = (name: string) => /^[a-z]+:([\s\S]*):[0-9a-f]{64}$/.exec(name)?.[1] ?? name;

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
      const lasted = (yield* Clock.currentTimeMillis) - called;
      const waited = durationMillis !== undefined && lasted >= durationMillis;
      if (transient !== undefined && waited) {
        yield* Effect.annotateCurrentSpan({
          "executor.workflow.call.attempts": attempts,
          "executor.workflow.call.waited": true,
          "executor.workflow.call.waited_ms": lasted,
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
