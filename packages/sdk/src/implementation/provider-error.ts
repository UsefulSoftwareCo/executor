import type { Effect } from "effect";
import type { ProviderError } from "apps/contracts";
import { AppProviderFailed } from "../contracts/tools.ts";
import type { snapshot } from "./tools.ts";

/** Resolve attribution against this invocation's selected accounts; never trust authored labels or IDs. */
export function appProviderFailure(
  state: Effect.Success<ReturnType<typeof snapshot>>,
  error: ProviderError,
  credentialsRenewed = false,
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
    ...(credentialsRenewed ? { credentialsRenewed: true as const } : {}),
    ...(match === undefined
      ? {}
      : {
          account: { id: match.account.id, label: match.account.label, provider: match.provider },
        }),
  });
}
