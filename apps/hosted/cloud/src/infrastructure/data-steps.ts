import { AppManagementHost } from "@executor-js/app-management";
import {
  catalogCopyRebuildScope,
  hostDataSteps,
  runDataSteps,
  type AgentGrantExpiry,
  type DataStepRun,
} from "@executor-js/app-management/data-steps";
import { GroupDatabase } from "@executor-js/hosted-server/groups";
import {
  executorDefaultRedeployed,
  hostedAppCopies,
  ScheduleWakeup,
} from "@executor-js/hosted-server";
import { Clock, Config, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { cloudBlobs } from "./blobs.ts";
import { jobUnitCounts } from "../contracts/job-outcome.ts";

const tickBudgetMs = 20_000;

const catalogCopyRebuildPace = 2;

const catalogCopyRebuildPasses = 24;

const reviewedThrough = "2_app_framework_pin_catch_up";

const tickOutcome = (...runs: ReadonlyArray<DataStepRun>) =>
  jobUnitCounts(
    runs.reduce((total, run) => total + run.attempted, 0),
    runs.reduce((total, run) => total + run.failed, 0),
    "DataStepItemFailed",
  );

export const cloudDataSteps = (agentGrants: AgentGrantExpiry) =>
  Effect.gen(function* () {
    const mode = yield* Config.Literals(["report", "apply"], "CLOUD_DATA_STEPS").pipe(
      Config.withDefault("report" as const),
    );
    const report = yield* Config.NonEmptyString("CLOUD_DATA_STEPS_REPORT").pipe(
      Config.withDefault("cloud"),
    );
    const named = yield* Config.String("CLOUD_DATA_STEPS_APPLY_THROUGH").pipe(
      Config.withDefault(""),
    );
    const applyThrough = named === "" ? reviewedThrough : named;
    const scopeText = yield* Config.String("CLOUD_CATALOG_COPY_REBUILD_SCOPE").pipe(
      Config.withDefault(""),
    );
    const scope = yield* catalogCopyRebuildScope(scopeText).pipe(
      Effect.catchTag("CatalogCopyRebuildScopeInvalid", (error) =>
        Effect.logError("CLOUD_CATALOG_COPY_REBUILD_SCOPE cannot be read", error.token).pipe(
          Effect.andThen(catalogCopyRebuildScope("")),
        ),
      ),
    );
    const paceText = yield* Config.String("CLOUD_CATALOG_COPY_REBUILD_PACE").pipe(
      Config.withDefault(""),
    );
    const pace = /^\d+$/u.test(paceText) ? Number(paceText) : catalogCopyRebuildPace;
    const blobs = yield* cloudBlobs;
    return Effect.gen(function* () {
      const wake = yield* ScheduleWakeup;
      const { executor } = yield* Effect.flatten(AppManagementHost);
      const sql = yield* Effect.flatten(GroupDatabase);
      const deadline = (yield* Clock.currentTimeMillis) + tickBudgetMs;
      const steps = hostDataSteps({
        executor,
        blobs,
        agentGrants,
        executorAppRedeployed: executorDefaultRedeployed(wake),
        appCopies: hostedAppCopies(executor),
        catalogCopyRebuild: {
          rebuilt: () => wake,
          scope,
          pace,
          passes: catalogCopyRebuildPasses,
        },
      });
      const run = (selected: typeof steps, selectedMode: typeof mode) =>
        runDataSteps(selected, {
          journal: "private_hosted",
          mode: selectedMode,
          report,
          exclusive: false,
          deadline,
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      if (mode === "report") return tickOutcome(yield* run(steps, "report"));
      const through = steps.findIndex((step) => step.name === applyThrough);
      if (through < 0) {
        yield* Effect.logError("CLOUD_DATA_STEPS_APPLY_THROUGH names no data step", applyThrough);
        return tickOutcome(yield* run(steps, "report"));
      }
      const applied = yield* run(steps.slice(0, through + 1), "apply");
      return applied.status === "complete"
        ? tickOutcome(applied, yield* run(steps.slice(through + 1), "report"))
        : tickOutcome(applied);
    }).pipe(
      Effect.withSpan("job.data-steps", {
        attributes: {
          "data_step.mode": mode,
          "data_step.apply_through": applyThrough,
          "data_step.catalog_rebuild_run": scope.run,
          "data_step.catalog_rebuild_pace": pace,
        },
      }),
    );
  }).pipe(Effect.orDie);
