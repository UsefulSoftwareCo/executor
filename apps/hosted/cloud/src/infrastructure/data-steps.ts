/**
 * Cloud runs data steps inside the new Worker after it deploys. Schema migrations run earlier, in
 * Alchemy, with only a database connection; data steps need the Worker's services, such as app
 * source in Cloudflare Artifacts. The minute cron advances them from the SQL journal the schema
 * migration created, never from a request. An older Worker version does not know a new step, so
 * the first tick of the version that ships it starts it. A pass that leaves items to retry records
 * a backoff in the journal, so a step that keeps failing is not retried every minute.
 *
 * Each tick's outcome counts the items it handled: `partial` or `failed` when some or all of them
 * ended with an outcome their step retries. A tick that only waited for a lease or a backoff, or
 * ran out of time, records `completed`.
 *
 * The catalog-copy rebuild applies in stages: `CLOUD_CATALOG_COPY_REBUILD_SCOPE` names the copies
 * a stage may change (none when unset), and `CLOUD_CATALOG_COPY_REBUILD_PACE` the compiler builds
 * one tick starts for it, in report and apply alike. See notes/catalog-copy-rebuild.md.
 */
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

/** A tick stops starting items after this long, then resumes from its cursor on the next tick. */
const tickBudgetMs = 20_000;

/**
 * The compiler builds one tick starts for the catalog-copy rebuild when no deploy sets a pace.
 * Measured on a test stage (notes/catalog-copy-rebuild.md, "Load").
 */
const catalogCopyRebuildPace = 2;

/**
 * Retry passes before a catalog copy still failing is recorded `gave-up`: about 30 seconds,
 * doubling to an hour, so about a day of retries.
 */
const catalogCopyRebuildPasses = 24;

/**
 * The last step that `apply` applies when no deploy names one. Steps after it report however
 * `CLOUD_DATA_STEPS` is set, so a new step ships in report mode even where earlier steps apply.
 * Never move this forward to approve a step; set the deploy variable instead.
 */
const reviewedThrough = "2_app_framework_pin_catch_up";

/** A tick's outcome over the items its runs handled. */
const tickOutcome = (...runs: ReadonlyArray<DataStepRun>) =>
  jobUnitCounts(
    runs.reduce((total, run) => total + run.attempted, 0),
    runs.reduce((total, run) => total + run.failed, 0),
    "DataStepItemFailed",
  );

/**
 * Read during Worker initialization, so Alchemy binds the deploy's values into the Worker.
 * `CLOUD_DATA_STEPS` is `report` unless a deploy sets `apply`. `apply` applies steps up to and
 * including `CLOUD_DATA_STEPS_APPLY_THROUGH` (`reviewedThrough` when unset or empty); later steps
 * report until a deploy names them, and start only once every applied step is complete. Every
 * deploy resumes the same report, `report:<CLOUD_DATA_STEPS_REPORT>` (`report:cloud` by default):
 * step names are immutable, so a later build's outcomes for a step are comparable with an earlier
 * one's. A report restarts from the first item only when a deploy sets a new label.
 */
export const cloudDataSteps = (agentGrants: AgentGrantExpiry) =>
  Effect.gen(function* () {
    const mode = yield* Config.Literals(["report", "apply"], "CLOUD_DATA_STEPS").pipe(
      Config.withDefault("report" as const),
    );
    const report = yield* Config.NonEmptyString("CLOUD_DATA_STEPS_REPORT").pipe(
      Config.withDefault("cloud"),
    );
    // The deploy workflow passes an unset repository variable as an empty string.
    const named = yield* Config.String("CLOUD_DATA_STEPS_APPLY_THROUGH").pipe(
      Config.withDefault(""),
    );
    const applyThrough = named === "" ? reviewedThrough : named;
    const scopeText = yield* Config.String("CLOUD_CATALOG_COPY_REBUILD_SCOPE").pipe(
      Config.withDefault(""),
    );
    // An unreadable scope selects nothing rather than a guess at what was meant.
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
    // The build framework step rewrites retained builds in the same bucket the executor reads.
    const blobs = yield* cloudBlobs;
    return Effect.gen(function* () {
      // A redeploy leaves its app's webhook sources pending; the job wakes reconciliation for them.
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
        // Cloud lists the catalog-copy rebuild; it reports until a deploy names it (above).
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
        // Hold everything rather than guess which steps were approved.
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
