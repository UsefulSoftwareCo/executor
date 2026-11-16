import { cloudArtifactsTokensLive } from "./artifacts-tokens.ts";
import { cloudSentry, reportCloudFailure } from "../implementation/error-reporting.ts";
/** One native Cloudflare workflow routes every run to its retained Dynamic Worker app build. */
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
  type EngineFault,
  nativeEngineFailure,
  workflowFailureMessage,
} from "@executor-js/sdk/core";
import { cloudEmulators } from "./emulators.ts";
import { cloudProduct } from "./product.ts";
import { appDataSupervisors } from "./app-data.ts";
import { safe } from "./workflow-runtime.ts";

/**
 * A sleep the native engine refused or failed: the platform answered, so the failure names the
 * platform's error class and classified code. A failure carrying our own marker passes through.
 */
const nativeSleep = (effect: Effect.Effect<void>) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.interrupt;
      return Effect.fail(nativeEngineFailure(Cause.squash(cause)));
    }),
  );

/** A retryable step failure. The engine serializes its encoded message, so a replay decodes the same. */
class RetryableStepFailure extends Schema.TaggedError<RetryableStepFailure>()(
  "RetryableStepFailure",
  { message: Schema.String },
) {}

const encode = workflowFailureMessage;

/**
 * E2E runs only: engine call faults (`engine-faults.ts`), read only where emulated providers run,
 * which only loopback Cloud and `test-e2e-` stages accept.
 */
const engineFaults = Effect.gen(function* () {
  if (Option.isNone(yield* cloudEmulators.pipe(Effect.orDie))) return null;
  const configured = yield* Config.option(Config.String("EXECUTOR_TEST_WORKFLOW_ENGINE_FAULTS"));
  if (Option.isNone(configured)) return null;
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(EngineFaults))(
    configured.value,
  ).pipe(Effect.orDie);
});

/** A sleep failed by an E2E fault, before the engine sees it or after it waited. */
const faulted = (fault: EngineFault | undefined, sleep: Effect.Effect<void>) =>
  fault === undefined
    ? sleep
    : fault.when === "before"
      ? Effect.die(engineFaultError(fault))
      : Effect.flatMap(sleep, () => Effect.die(engineFaultError(fault)));

const runWorkflow = (
  input: { run: string },
  faults: ReadonlyArray<EngineFault> | null,
): Effect.Effect<Schema.Json, never, Cloudflare.Workflows.WorkflowServices | HostedExecutor> =>
  Effect.gen(function* () {
    const { NonRetryableError } = yield* Effect.promise(() => import("cloudflare:workflows"));
    const run = yield* Schema.decodeUnknownEffect(WorkflowRunId)(input.run);
    const step = yield* Cloudflare.Workflows.WorkflowStep;
    const services = yield* Effect.context<never>();
    const executor = yield* Effect.flatten(HostedExecutor);
    const driver: WorkflowDriver = {
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
                // The engine retries typed failures and stops at a defect.
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
        nativeSleep(faulted(engineFaultFor(faults, run, name), step.sleep(name, duration))),
      sleepUntil: (name, timestamp) =>
        nativeSleep(faulted(engineFaultFor(faults, run, name), step.sleepUntil(name, timestamp))),
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
/** Step callbacks run inside the app's Dynamic Worker; the Cloudflare engine owns the journal. */
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
