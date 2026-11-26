import { cloudArtifactsTokensLive } from "./artifacts-tokens.ts";
import { cloudSentry, reportCloudFailure } from "../implementation/error-reporting.ts";
import { cloudAnalytics, recordBackgroundUsage } from "../implementation/product-analytics.ts";
import * as Cloudflare from "alchemy/Cloudflare";
import { Cause, Clock, Config, Effect, Exit, Option, Schema } from "effect";
import { HostedExecutor } from "@executor-js/hosted-server";
import {
  WorkflowHost,
  WorkflowRunId,
  type WorkflowDriver,
  EngineFaults,
  engineFaultError,
  engineFaultFor,
  engineLateFor,
  type EngineFault,
  type EngineFaultList,
  nativeEngineFailure,
  workflowFailureMessage,
} from "@executor-js/sdk/core";
import { cloudEmulators } from "./emulators.ts";
import { cloudProduct } from "./product.ts";
import { appDataSupervisors } from "./app-data.ts";
import { safe } from "./workflow-runtime.ts";

const nativeSleep = (effect: Effect.Effect<void>) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.interrupt;
      return Effect.fail(nativeEngineFailure(Cause.squash(cause)));
    }),
  );

class RetryableStepFailure extends Schema.TaggedError<RetryableStepFailure>()(
  "RetryableStepFailure",
  { message: Schema.String },
) {}

const encode = workflowFailureMessage;

const engineFaults = Effect.gen(function* () {
  if (Option.isNone(yield* cloudEmulators.pipe(Effect.orDie))) return null;
  const configured = yield* Config.option(Config.String("EXECUTOR_TEST_WORKFLOW_ENGINE_FAULTS"));
  if (Option.isNone(configured)) return null;
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(EngineFaults))(
    configured.value,
  ).pipe(Effect.orDie);
});

const faulted = (
  late: number | undefined,
  fault: EngineFault | undefined,
  call: Effect.Effect<void>,
) => {
  const sleep =
    late === undefined
      ? call
      : Effect.andThen(
          Effect.promise(() => new Promise((settle) => setTimeout(settle, late))),
          call,
        );
  return fault === undefined
    ? sleep
    : fault.when === "before"
      ? Effect.die(engineFaultError(fault))
      : Effect.flatMap(sleep, () => Effect.die(engineFaultError(fault)));
};

const runWorkflow = (
  input: { run: string },
  faults: EngineFaultList | null,
): Effect.Effect<Schema.Json, never, Cloudflare.Workflows.WorkflowServices | HostedExecutor> =>
  Effect.gen(function* () {
    const { NonRetryableError } = yield* Effect.promise(() => import("cloudflare:workflows"));
    const run = yield* Schema.decodeUnknownEffect(WorkflowRunId)(input.run);
    const step = yield* Cloudflare.Workflows.WorkflowStep;
    const services = yield* Effect.context<never>();
    const executor = yield* Effect.flatten(HostedExecutor);
    const driver: WorkflowDriver = {
      waitForInput: (name, id, expiresAt) =>
        Effect.gen(function* () {
          const remaining = expiresAt - (yield* Clock.currentTimeMillis);
          if (remaining <= 0) return;
          yield* safe(step.waitForEvent(name, { type: id, timeout: remaining })).pipe(
            Effect.catch((error) =>
              Effect.flatMap(Clock.currentTimeMillis, (now) =>
                now >= expiresAt ? Effect.void : Effect.fail(error),
              ),
            ),
            Effect.asVoid,
          );
        }),
      do: (name, options, work) => {
        const fault = engineFaultFor(faults, run, name);
        if (fault?.when === "before")
          return Effect.fail(nativeEngineFailure(engineFaultError(fault)));
        const call = safe(
          step.do({
            name,
            ...options,
            effect: Effect.suspend(() =>
              work().pipe(
                Effect.tapCause(reportCloudFailure),
                Effect.withSpan("workflow.step", {
                  attributes: {
                    "executor.run.id": run,
                    "executor.workflow.step": name,
                    "executor.attempt.id": crypto.randomUUID(),
                  },
                }),
                Effect.provideContext(services),
                Effect.catch((error) =>
                  error.retryable
                    ? Effect.fail(new RetryableStepFailure({ message: encode(error) }))
                    : Effect.die(new NonRetryableError(encode(error))),
                ),
              ),
            ),
          }),
        );
        return fault === undefined
          ? call
          : call.pipe(
              Effect.flatMap(() => Effect.fail(nativeEngineFailure(engineFaultError(fault)))),
            );
      },
      sleep: (name, duration) =>
        nativeSleep(
          faulted(
            engineLateFor(faults, run, name),
            engineFaultFor(faults, run, name),
            step.sleep(name, duration),
          ),
        ),
      sleepUntil: (name, timestamp) =>
        nativeSleep(
          faulted(
            engineLateFor(faults, run, name),
            engineFaultFor(faults, run, name),
            step.sleepUntil(name, timestamp),
          ),
        ),
    };
    const started = yield* Clock.currentTimeMillis;
    return yield* executor[WorkflowHost].execute(run, driver).pipe(
      Effect.onExit((exit) =>
        Effect.flatMap(Clock.currentTimeMillis, (finished) =>
          recordBackgroundUsage("workflow_attempt_completed", "workflows", {
            run_id: run,
            outcome: Exit.isSuccess(exit) ? "success" : "failure",
            ok: Exit.isSuccess(exit),
            duration_ms: Math.max(0, finished - started),
          }),
        ),
      ),
    );
  }).pipe(Effect.orDie);
export class AppWorkflows extends Cloudflare.Workflow<AppWorkflows>()(
  "AppWorkflows",
  Effect.gen(function* () {
    const executor = yield* cloudProduct(
      yield* appDataSupervisors,
      yield* cloudArtifactsTokensLive,
    );
    const analytics = yield* cloudAnalytics;
    const report = yield* cloudSentry;
    const faults = yield* engineFaults;
    return (input: { run: string }) =>
      Effect.scoped(
        report(
          analytics.wrap(
            runWorkflow(input, faults).pipe(
              Effect.provide(executor),
              Effect.tapCause(reportCloudFailure),
              Effect.withSpan("workflow.attempt", {
                root: true,
                attributes: {
                  "executor.run.id": input.run,
                  "executor.attempt.id": crypto.randomUUID(),
                },
              }),
            ),
          ),
        ),
      );
  }),
) {}
