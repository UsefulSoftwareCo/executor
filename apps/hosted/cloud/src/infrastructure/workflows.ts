import { cloudSentry, reportCloudFailure } from "../implementation/error-reporting.ts";
/** One native Cloudflare workflow routes every run to its retained Dynamic Worker app build. */
import { cloudAnalytics, recordBackgroundUsage } from "../implementation/product-analytics.ts";
import * as Cloudflare from "alchemy/Cloudflare";
import type { Workflow } from "@cloudflare/workers-types";
import { Cause, Clock, Effect, Exit, Schema, Option, Result } from "effect";
import { HostedExecutor } from "@executor-js/hosted-server";
import {
  WorkflowHost,
  WorkflowRunId,
  WorkflowBackendState,
  type WorkflowRuntime,
  type WorkflowDriver,
  WorkflowFailure,
} from "@executor-js/sdk/core";
import { cloudExecutor } from "./executor.ts";
import { AppDataSupervisor } from "./app-data.ts";

const failure = () => new WorkflowFailure({ reason: "engine", retryable: true });
const encode = (error: WorkflowFailure) =>
  `ExecutorWorkflowFailure(${error.reason},${error.retryable})`;
const recover = (error: unknown): WorkflowFailure => {
  const match =
    error instanceof Error
      ? /ExecutorWorkflowFailure\(([a-z_]+),(true|false)\)/.exec(error.message)
      : null;
  if (match !== null) {
    const reason = Schema.decodeUnknownOption(WorkflowFailure.fields.reason)(match[1]);
    if (Option.isSome(reason))
      return new WorkflowFailure({ reason: reason.value, retryable: match[2] === "true" });
  }
  return failure();
};
const safe = <A, R>(effect: Effect.Effect<A, unknown, R>): Effect.Effect<A, WorkflowFailure, R> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(recover(Cause.squash(cause))),
    ),
  );

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
                Effect.catch((error) =>
                  Effect.die(
                    error.retryable
                      ? new Error(encode(error))
                      : new NonRetryableError(encode(error)),
                  ),
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
    const executor = yield* cloudExecutor(yield* AppDataSupervisor);
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

const NativeWorkflow = Schema.declare(
  (value): value is Pick<Workflow<{ run: string }>, "get" | "create"> =>
    typeof value === "object" &&
    value !== null &&
    "get" in value &&
    typeof value.get === "function" &&
    "create" in value &&
    typeof value.create === "function",
);
const native = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: (error) => error });

/** Use the API-owned binding. App-page Workers bind the same workflow through their env. */
export const cloudWorkflows: Effect.Effect<WorkflowRuntime, never, Cloudflare.WorkerEnvironment> =
  Effect.gen(function* () {
    const environment = yield* Cloudflare.WorkerEnvironment;
    // Resolve native handles only during invocation, after Alchemy has installed bindings.
    const binding = Effect.suspend(() =>
      Schema.decodeUnknownEffect(NativeWorkflow)(environment.AppWorkflows),
    ).pipe(Effect.mapError(failure));
    const status: WorkflowRuntime["status"] = (run) =>
      binding.pipe(
        Effect.flatMap((binding) => native(async () => (await binding.get(run)).status())),
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(WorkflowBackendState)(
            value.status === "unknown" ? { status: "missing" } : value,
          ),
        ),
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause);
          if (error instanceof Error && error.message.includes("instance.not_found"))
            return Effect.succeed({ status: "missing" } as const);
          return Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(recover(error));
        }),
      );
    return {
      status,
      start: (run) =>
        Effect.gen(function* () {
          if ((yield* status(run)).status !== "missing") return;
          const namespace = yield* binding;
          const created = yield* safe(
            native(() => namespace.create({ id: run, params: { run } })),
          ).pipe(Effect.result);
          if (Result.isFailure(created) && (yield* status(run)).status === "missing")
            return yield* created.failure;
        }),
      terminate: (run) =>
        Effect.gen(function* () {
          const current = yield* status(run);
          if (["missing", "complete", "errored", "terminated"].includes(current.status)) return;
          const namespace = yield* binding;
          const instance = yield* safe(native(() => namespace.get(run)));
          yield* safe(native(() => instance.terminate()));
        }),
    } satisfies WorkflowRuntime;
  });
