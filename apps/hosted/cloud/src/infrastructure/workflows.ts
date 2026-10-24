import { cloudArtifactsTokensLive } from "./artifacts-tokens.ts";
import { cloudSentry, reportCloudFailure } from "../implementation/error-reporting.ts";
/** One native Cloudflare workflow routes every run to its retained Dynamic Worker app build. */
import { cloudAnalytics, recordBackgroundUsage } from "../implementation/product-analytics.ts";
import * as Cloudflare from "alchemy/Cloudflare";
import { Clock, Effect, Exit, Schema } from "effect";
import { HostedExecutor } from "@executor-js/hosted-server";
import {
  WorkflowFailure,
  WorkflowHost,
  WorkflowRunId,
  decodeWorkflowFailure,
  type WorkflowDriver,
  workflowFailureMessage,
} from "@executor-js/sdk/core";
import { cloudProduct } from "./product.ts";
import { appDataSupervisors } from "./app-data.ts";
import { safe } from "./workflow-runtime.ts";
import {
  encryptedWorkflowResult,
  encryptedWorkflowTask,
  isEncryptedWorkflowInstance,
  type WorkflowEncryptionKey,
  workflowEncryptionKey,
  workflowResults,
  workflowResultInput,
} from "./workflow-results.ts";

/** A retryable step failure. The engine serializes its message for a later replay. */
class RetryableStepFailure extends Schema.TaggedError<RetryableStepFailure>()(
  "RetryableStepFailure",
  { message: Schema.String },
) {}

const encode = workflowFailureMessage;

const runEncryptedWorkflow = (
  input: { run: string },
  encryptionKey: WorkflowEncryptionKey,
): Effect.Effect<Uint8Array, never, Cloudflare.Workflows.WorkflowServices | HostedExecutor> =>
  Effect.gen(function* () {
    const run = yield* Schema.decodeUnknownEffect(WorkflowRunId)(input.run);
    const results = yield* workflowResults(run, encryptionKey);
    const step = yield* Cloudflare.Workflows.WorkflowStep;
    const services = yield* Effect.context<never>();
    const executor = yield* Effect.flatten(HostedExecutor);
    const driver: WorkflowDriver = {
      do: (name, options, work) =>
        safe(
          encryptedWorkflowTask({
            results,
            name,
            options,
            work: () =>
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
              ),
            encodeFailure: (error) =>
              workflowFailureMessage(
                Schema.is(WorkflowFailure)(error) ? error : decodeWorkflowFailure(error),
              ),
            isRetryable: (error) => (Schema.is(WorkflowFailure)(error) ? error.retryable : true),
            restoreFailure: (failure) => decodeWorkflowFailure(new Error(failure.message)),
          }).pipe(Effect.provideService(Cloudflare.Workflows.WorkflowStep, step)),
        ),
      sleep: (name, duration) =>
        results.withStep(
          name,
          Effect.flatMap(results.storedStepName(name), (storedName) =>
            safe(step.sleep(storedName, duration)),
          ),
        ),
      sleepUntil: (name, timestamp) =>
        results.withStep(
          name,
          Effect.flatMap(results.storedStepName(name), (storedName) =>
            safe(step.sleepUntil(storedName, timestamp)),
          ),
        ),
    };
    const started = yield* Clock.currentTimeMillis;
    const execution = executor[WorkflowHost].execute(run, driver).pipe(
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
    return yield* encryptedWorkflowResult({
      results,
      work: execution,
      encodeFailure: (error) =>
        workflowFailureMessage(
          Schema.is(WorkflowFailure)(error) ? error : decodeWorkflowFailure(error),
        ),
      isRetryable: (error) => (Schema.is(WorkflowFailure)(error) ? error.retryable : true),
    });
  }).pipe(Effect.orDie);

/** Preserve the checkpoint names and retry behavior for instances created before encryption. */
const runLegacyWorkflow = (input: {
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

const runWorkflow = (
  input: { run: string },
  encryptionKey: WorkflowEncryptionKey,
  encrypted: boolean,
): Effect.Effect<
  Schema.Json | Uint8Array,
  never,
  Cloudflare.Workflows.WorkflowServices | HostedExecutor
> => (encrypted ? runEncryptedWorkflow(input, encryptionKey) : runLegacyWorkflow(input));
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
    const encryptionKey = yield* workflowEncryptionKey;
    return (input: unknown) =>
      Effect.gen(function* () {
        const request = yield* workflowResultInput(input);
        const event = yield* Cloudflare.Workflows.WorkflowEvent;
        if (isEncryptedWorkflowInstance(event.instanceId) !== (request.mode === "encrypted"))
          return yield* Effect.die(new WorkflowFailure({ reason: "engine", retryable: false }));
        const params = yield* Schema.decodeUnknownEffect(Schema.Struct({ run: WorkflowRunId }))(
          request.params,
        );
        return yield* Effect.scoped(
          report(
            analytics.wrap(
              runWorkflow(params, encryptionKey, request.mode === "encrypted").pipe(
                Effect.provide(executor),
                Effect.tapCause(reportCloudFailure),
                Effect.withSpan("workflow.attempt", {
                  root: true,
                  attributes: {
                    "executor.run.id": params.run,
                    "executor.attempt.id": crypto.randomUUID(),
                  },
                }),
              ),
            ),
          ),
        );
      });
  }),
) {}
