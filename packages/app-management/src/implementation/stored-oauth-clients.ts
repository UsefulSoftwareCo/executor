import { SavedOAuthClientsHost, type Executor } from "@executor-js/sdk/core";
import { Effect } from "effect";
import type { DataStep, DataStepMode } from "../contracts/data-steps.ts";

export interface StoredOAuthClientsHost {
  readonly executor: Executor;
}

export const storedOAuthClientsStepName = "6_stored_oauth_clients";

export const storedOAuthClientsStep = (host: StoredOAuthClientsHost): DataStep<never> => ({
  name: storedOAuthClientsStepName,
  retry: ["unavailable"],
  items: host.executor[SavedOAuthClientsHost].items.pipe(
    Effect.map((items) =>
      items.map((item) => ({
        id: item.id,
        owner: item.owner ?? item.bucket ?? "",
        run: (mode: DataStepMode) => item.move(mode === "apply"),
      })),
    ),
  ),
});
