/** The data steps every host runs, in order. Local, self-host and Cloud share this one list. */
import { Clock, Config, Effect } from "effect";
import type { DataStepJournal } from "../contracts/data-steps.ts";
import { runDataSteps } from "./data-steps.ts";
import { frameworkPinCatchUpRelease, frameworkPinRelease } from "../contracts/framework-pin.ts";
import { frameworkPinStep, type FrameworkPinHost } from "./framework-pin.ts";
import { buildFrameworkOnceStep, type BuildFrameworkHost } from "./build-framework-once.ts";
import {
  idleAgentGrantsStep,
  idleAgentGrantsStepName,
  type AgentGrantHost,
} from "./idle-agent-grants.ts";
import { executorAppRedeployStep, type ExecutorAppRedeployHost } from "./executor-app-redeploy.ts";
import { executorAppRedeployStepName } from "../contracts/executor-app-redeploy.ts";
import type { SqlClient } from "effect/sql";
import type { DataStep } from "../contracts/data-steps.ts";

/** The host services every step together reads and writes through. */
export type DataStepHost = FrameworkPinHost &
  BuildFrameworkHost &
  AgentGrantHost &
  ExecutorAppRedeployHost;

/** Append new steps; never rename, reorder or change one that has shipped. */
export const hostDataSteps = (host: DataStepHost): ReadonlyArray<DataStep<SqlClient.SqlClient>> => [
  frameworkPinStep(host, "1_app_framework_pin", frameworkPinRelease),
  // Builds now require a declaration. Pin apps created without one after the first pass ran. The
  // hosts that created them built undeclared source with their own protocol-1 framework.
  frameworkPinStep(host, "2_app_framework_pin_catch_up", frameworkPinCatchUpRelease),
  // Store each retained build's framework once, beside the inlined copy, which stays.
  buildFrameworkOnceStep(host, "3_build_framework_once"),
  // Revoke OAuth grants that can never be used again and have been idle for 30 days.
  idleAgentGrantsStep(host, idleAgentGrantsStepName),
  // One-off: redeploy Executor apps built on an apps release before beta.10, whose background
  // cache refreshes aborted with the invocation, with only their apps pin moved to this host's.
  executorAppRedeployStep(host, executorAppRedeployStepName),
];

/**
 * Local and self-host apply pending steps at startup. `report` holds them: each start then reports
 * what applying would do, writes nothing and records no step as applied.
 */
export const startupDataStepMode = Config.Literals(["report", "apply"], "EXECUTOR_DATA_STEPS").pipe(
  Config.withDefault("apply" as const),
);

/**
 * Run pending steps once the schema is current and before the host serves or builds anything.
 * The caller holds the host's exclusive directory lock. Items left to retry, such as a conflict,
 * are retried at the next start; other items are not handled again.
 */
export const runStartupDataSteps = (host: DataStepHost, journal: DataStepJournal) =>
  Effect.gen(function* () {
    const mode = yield* startupDataStepMode;
    const status = yield* runDataSteps(hostDataSteps(host), {
      journal,
      mode,
      report: `startup-${yield* Clock.currentTimeMillis}`,
      exclusive: true,
    });
    if (mode === "apply" && status === "pending")
      yield* Effect.logWarning("Data steps left items to retry; the next start retries them");
  });
