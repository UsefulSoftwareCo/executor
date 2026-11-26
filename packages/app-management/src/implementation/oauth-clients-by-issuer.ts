import { SavedOAuthClientsHost, type Executor } from "@executor-js/sdk/core";
import { Effect } from "effect";
import type { DataStep, DataStepMode } from "../contracts/data-steps.ts";

export interface OAuthClientsByIssuerHost {
  readonly executor: Executor;
}

export const oauthClientsByIssuerStepName = "8_oauth_clients_by_issuer";
export const savedOAuthClientsByIssuerStepName = "9_saved_oauth_clients_by_issuer";

export const oauthClientsByIssuerStep = (host: OAuthClientsByIssuerHost): DataStep<never> => ({
  name: oauthClientsByIssuerStepName,
  retry: ["unavailable"],
  items: host.executor[SavedOAuthClientsHost].issuerItems.pipe(
    Effect.map((items) =>
      items.map((item) => ({
        id: item.id,
        owner: item.owner,
        run: (mode: DataStepMode) => item.migrate(mode === "apply"),
      })),
    ),
  ),
});

export const savedOAuthClientsByIssuerStep = (host: OAuthClientsByIssuerHost): DataStep<never> => ({
  name: savedOAuthClientsByIssuerStepName,
  retry: ["unavailable"],
  items: host.executor[SavedOAuthClientsHost].itemsByIssuer.pipe(
    Effect.map((items) =>
      items.map((item) => ({
        id: item.id,
        owner: item.owner ?? "",
        run: (mode: DataStepMode) => item.move(mode === "apply"),
      })),
    ),
  ),
});
