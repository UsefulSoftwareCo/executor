/** One shared Alchemy stack owns zone-wide TLS settings; product stages only reference its outputs. */
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import type { Redacted } from "effect";
import type { AppDomainZoneSettings } from "../contracts/app-domains.ts";

/** The public configuration is separate from the redacted token so the latter becomes a secret binding. */
export interface AppDomainZoneOutput {
  readonly zone: typeof AppDomainZoneSettings.Type;
  readonly controllerToken: Redacted.Redacted<string>;
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
