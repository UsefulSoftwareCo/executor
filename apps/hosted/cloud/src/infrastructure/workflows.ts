import { cloudArtifactsTokensLive } from "./artifacts-tokens.ts";
import { cloudSentry, reportCloudFailure } from "../implementation/error-reporting.ts";
/** One native Cloudflare workflow routes every run to its retained Dynamic Worker app build. */
import { cloudAnalytics, recordBackgroundUsage } from "../implementation/product-analytics.ts";
import * as Cloudflare from "alchemy/Cloudflare";
import { Clock, Effect, Exit, Schema } from "effect";
import { HostedExecutor } from "@executor-js/hosted-server";
import {
  WorkflowHost,
  WorkflowRunId,
  type WorkflowDriver,
  workflowFailureMessage,
} from "@executor-js/sdk/core";
import { cloudProduct } from "./product.ts";
import { appDataSupervisors } from "./app-data.ts";
import { safe } from "./workflow-runtime.ts";

/** A retryable step failure. The engine serializes its encoded message, so a replay decodes the same. */
class RetryableStepFailure extends Schema.TaggedError<RetryableStepFailure>()(
  "RetryableStepFailure",
  { message: Schema.String },
) {}

const encode = workflowFailureMessage;

const runWorkflow = (input: {
  run: string;
}): Effect.Effect<Schema.Json, never, Cloudflare.Workflows.WorkflowServices | HostedExecutor> =>
  Effect.gen(function* () {
    const { NonRetryableError } = yield* Effect.promise(() => import("cloudflare:workflows"));
    const run = yield* Schema.decodeUnknownEffect(WorkflowRunId)(input.run);
    const step = yield* Cloudflare.Workflows.WorkflowStep;
    const services = yield* Effect.context<never>();
    const executor = yield* Effect.flatten(HostedExecutor);
    const driver: WorkflowDriver = {
      do: (name, options, work) =>
        safe(
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
        ),
      sleep: (name, duration) => safe(step.sleep(name, duration)),
      sleepUntil: (name, timestamp) => safe(step.sleepUntil(name, timestamp)),
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
    return (input: { run: string }) =>
      Effect.scoped(
        report(
          analytics.wrap(
            runWorkflow(input).pipe(
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
