/** Activating a deployment wakes profile setup at the shared hosted Executor boundary. */
import type { Executor } from "@executor-js/sdk/core";
import { Effect, Option } from "effect";
import { ScheduleWakeup } from "../contracts/schedules.ts";

/**
 * Executor operations require no services, so this reads the wake its caller supplies when the
 * deploy commits. Hosted routes and background jobs that deploy through this executor (the
 * dashboard, app management, MCP and Cloud data steps) each supply one. A deploy without a wake is
 * a wiring fault: it is reported, and setup waits for polling.
 */
const wake = Effect.serviceOption(ScheduleWakeup).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.logError("A deploy committed with no profile setup wake"),
      onSome: (wake) => wake,
    }),
  ),
);

/**
 * A deployment activated over an existing app leaves every profile of the app pending until setup
 * re-registers its webhooks and schedules, so each deploy and activation through this executor
 * wakes setup as profile writes do; polling stays the recovery path. A new app has no profiles yet,
 * and a deploy that a newer one overtook activates nothing. Member setup deploys the default
 * Executor app through its own executor and wakes setup itself.
 */
export const withDeploySetupWake = (executor: Executor): Executor => ({
  ...executor,
  apps: {
    ...executor.apps,
    deploy: (input) =>
      executor.apps
        .deploy(input)
        .pipe(
          Effect.tap(({ app, deployment }) =>
            input.app !== undefined && app.activeDeployment === deployment.id ? wake : Effect.void,
          ),
        ),
    activate: (input) => executor.apps.activate(input).pipe(Effect.tap(() => wake)),
  },
});
