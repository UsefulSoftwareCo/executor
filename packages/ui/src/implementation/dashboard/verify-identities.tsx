/** Retained sign-ins are verified in bounded batches; an unavailable proof leaves them independent. */
import { useState, type ComponentType } from "react";
import { Exit, Option, type Cause } from "effect";
import type { Account, AccountId } from "@executor-js/sdk";
import type { FailureProps, Inventory, Query } from "../../contracts/dashboard.ts";
import { useQuery } from "./context.tsx";
import { Button } from "../components/button.tsx";

export function VerifyIdentities<E>({
  query,
  identify,
  Failure,
}: {
  readonly query: Query<Inventory, E>;
  readonly identify: (accounts: readonly AccountId[]) => Promise<Exit.Exit<readonly Account[], E>>;
  readonly Failure: ComponentType<FailureProps<E>>;
}) {
  const { data, refresh } = useQuery(query);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Cause.Cause<E>>();
  const [missing, setMissing] = useState(false);
  const inventory = Option.getOrUndefined(data);
  const accounts =
    inventory !== undefined
      ? inventory.accounts
          .filter(
            (account) =>
              account.identity === undefined &&
              inventory.apps.some((app) =>
                Object.values(app.requirements.accounts).some(
                  (required) =>
                    required.provider === account.provider &&
                    required.definition.auth[account.method]?.type === "oauth2",
                ),
              ),
          )
          .slice(0, 5)
      : [];
  if (accounts.length === 0 && error === undefined && !missing) return null;
  return (
    <div className="space-y-2">
      {accounts.length > 0 && (
        <Button
          variant="outline"
          disabled={busy}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            setMissing(false);
            const result = await identify(accounts.map((account) => account.id));
            if (Exit.isFailure(result)) setError(result.cause);
            else setMissing(result.value.some((account) => account.identity === undefined));
            refresh();
            setBusy(false);
          }}
        >
          Verify saved accounts
        </Button>
      )}
      {missing && (
        <p className="max-w-80 text-xs text-muted-foreground">
          Some accounts could not verify their identity. Reconnect them from an app to repair their
          sign-in.
        </p>
      )}
      {error !== undefined && <Failure cause={error} layout="compact" />}
    </div>
  );
}
