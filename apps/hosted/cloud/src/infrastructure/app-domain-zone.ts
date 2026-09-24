/** One shared Alchemy stack owns zone-wide TLS settings; product stages only reference its outputs. */
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import { Effect, Option, type Redacted } from "effect";
import type { AppDomainZoneSettings } from "../contracts/app-domains.ts";
import { testStage } from "./stage.ts";

/** The public configuration is separate from the redacted token so the latter becomes a secret binding. */
export interface AppDomainZoneOutput {
  readonly zone: typeof AppDomainZoneSettings.Type;
  readonly controllerToken: Redacted.Redacted<string>;
  readonly testControllerToken: Redacted.Redacted<string>;
}

/** Deploy this shared stack once before enabling app domains on a hosted stage. */
export class AppDomainZone extends Alchemy.Stack<AppDomainZone, AppDomainZoneOutput>()(
  "executor-app-domain-zone",
) {}

/** Stage-independent reference to the single shared zone owner. */
export const sharedAppDomainZone = Output.stackRef<AppDomainZoneOutput>(
  "executor-app-domain-zone",
  { stage: "shared" },
);

/** Test domains use the shared deployment-user quota; production retains its account-owned token. */
export const appDomainControllerToken = Effect.gen(function* () {
  const shared = yield* sharedAppDomainZone;
  if (Option.isNone(yield* testStage))
    return shared.pipe(Output.map((value) => value.controllerToken));
  return shared.pipe(Output.map((value) => value.testControllerToken));
});
