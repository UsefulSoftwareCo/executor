import type { Executor } from "@executor-js/sdk/core";
import { Effect, Option } from "effect";
import { ScheduleWakeup } from "../contracts/schedules.ts";

const wake = Effect.serviceOption(ScheduleWakeup).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.logError("A deploy committed with no webhook source wake"),
      onSome: (wake) => wake,
    }),
  ),
);

export const withDeploySetupWake = (executor: Executor): Executor => ({
  ...executor,
  apps: {
    ...executor.apps,
    deploy: (input) =>
      executor.apps
        .deploy(input)
        .pipe(
          Effect.tap(({ app, version }) =>
            input.app !== undefined && app.activeVersion === version.id ? wake : Effect.void,
          ),
        ),
    activate: (input) => executor.apps.activate(input).pipe(Effect.tap(() => wake)),
  },
});
