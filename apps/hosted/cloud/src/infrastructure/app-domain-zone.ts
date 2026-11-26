import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import { Effect, Option, type Redacted } from "effect";
import type { AppDomainZoneSettings } from "../contracts/app-domains.ts";
import { testStage } from "./stage.ts";

export interface AppDomainZoneOutput {
  readonly zone: typeof AppDomainZoneSettings.Type;
  readonly controllerToken: Redacted.Redacted<string>;
  readonly testControllerToken: Redacted.Redacted<string>;
}

export class AppDomainZone extends Alchemy.Stack<AppDomainZone, AppDomainZoneOutput>()(
  "executor-app-domain-zone",
) {}

export const sharedAppDomainZone = Output.stackRef<AppDomainZoneOutput>(
  "executor-app-domain-zone",
  { stage: "shared" },
);

export const appDomainControllerToken = Effect.gen(function* () {
  const shared = yield* sharedAppDomainZone;
  if (Option.isNone(yield* testStage))
    return shared.pipe(Output.map((value) => value.controllerToken));
  return shared.pipe(Output.map((value) => value.testControllerToken));
});
