import { ProviderIdentitiesHost, type Executor } from "@executor-js/sdk/core";
import { Effect } from "effect";
import type { DataStep, DataStepMode } from "../contracts/data-steps.ts";

export interface ProviderIdentitiesStepHost {
  readonly executor: Executor;
}

export const providerIdentitiesStepName = "14_provider_identities";

export const providerIdentitiesStep = (host: ProviderIdentitiesStepHost): DataStep<never> => ({
  name: providerIdentitiesStepName,
  retry: ["unavailable"],
  items: host.executor[ProviderIdentitiesHost].items.pipe(
    Effect.map((items) =>
      items.map((item) => ({
        id: item.id,
        owner: "",
        run: (mode: DataStepMode) => item.record(mode === "apply"),
      })),
    ),
  ),
});
