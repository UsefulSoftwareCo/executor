/**
 * `11_provider_identities` records the identity of each provider stored before SDK storage 4.0.17:
 * its ID as its definition hashes without display text. A deploy finds the provider a definition
 * already has by it, so apps that word one provider differently share its ID and accounts. Deploys
 * record it on the rows they write; this step records the rest. Outcomes:
 * - `recorded` / `would_record`: its identity is, or would be, recorded.
 * - `already_recorded`: a deploy recorded it since the pass listed it.
 * - `absent`: removed since the pass listed it.
 * - `unreadable`: its stored definition does not decode; a deploy of it records it.
 * - `unavailable`: storage failed; a later pass retries.
 */
import { ProviderIdentitiesHost, type Executor } from "@executor-js/sdk/core";
import { Effect } from "effect";
import type { DataStep, DataStepMode } from "../contracts/data-steps.ts";

/** The host services the step reads and writes through. */
export interface ProviderIdentitiesStepHost {
  readonly executor: Executor;
}

/** Journal name. It never changes and the step never repeats. */
export const providerIdentitiesStepName = "11_provider_identities";

export const providerIdentitiesStep = (host: ProviderIdentitiesStepHost): DataStep<never> => ({
  name: providerIdentitiesStepName,
  retry: ["unavailable"],
  items: host.executor[ProviderIdentitiesHost].items.pipe(
    Effect.map((items) =>
      items.map((item) => ({
        id: item.id,
        // Providers have no owner; one definition serves every owner's apps.
        owner: "",
        run: (mode: DataStepMode) => item.record(mode === "apply"),
      })),
    ),
  ),
});
