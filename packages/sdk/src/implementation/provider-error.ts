import type { Effect } from "effect";
import type { ProviderError } from "apps/contracts";
import { AppProviderFailed, type RenewalFailure } from "../contracts/tools.ts";
import type { snapshot } from "./tools.ts";

/**
 * Resolve attribution against this invocation's selected accounts; never trust authored labels or
 * IDs. `renewal` is the outcome of renewing a refused account's credentials after a call that may
 * write, which is never repeated.
 */
export function appProviderFailure(
  state: Effect.Success<ReturnType<typeof snapshot>>,
  error: ProviderError,
  renewal?: "renewed" | RenewalFailure,
) {
  const selected = state.selections.flatMap(({ required, accounts }) =>
    accounts.map((account) => ({ account, provider: required.definition.name })),
  );
  const match = selected.find(({ account }) => account.id === error.accountId);
  return new AppProviderFailed({
    app: state.app.id,
    deployment: state.deployment.id,
    reason: error.reason,
    status: error.status,
    ...(error.phase === undefined ? {} : { phase: error.phase }),
    ...(error.upstream === undefined ? {} : { upstream: error.upstream }),
    ...(renewal === undefined
      ? {}
      : renewal === "renewed"
        ? { credentialsRenewed: true as const }
        : { renewalFailure: renewal }),
    ...(match === undefined
      ? {}
      : {
          account: { id: match.account.id, label: match.account.label, provider: match.provider },
        }),
  });
}
