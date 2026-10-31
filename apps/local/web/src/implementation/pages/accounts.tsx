import { VerifyIdentities } from "@executor-js/ui/dashboard/verify-identities";
import { useAtomSet } from "@effect/atom-react";
import { identifyAccountsAtom } from "../../contracts/accounts.ts";
import { IdentityAppPicker } from "@executor-js/ui/dashboard/identity-app-picker";
import { AppAccountForm } from "./account-form.tsx";
import { Failure } from "../components/common.tsx";
import { dashboardAtoms } from "../../contracts/dashboard-bindings.ts";
import { AccountsPage as SharedPage } from "@executor-js/ui/dashboard/accounts";
import { EmptyState } from "@executor-js/ui/dashboard/empty-state";
import { Button } from "@executor-js/ui/components/button";
import { Link } from "@tanstack/react-router";
import type { AccountId } from "@executor-js/sdk";
import { useState } from "react";
import {
  LocalAccountActions,
  LocalAccountDialog,
  type AccountDialogKind,
} from "./account-actions.tsx";
/** Local product supplies its own action and typed route. */
export function AccountsPage({ highlight }: { readonly highlight?: AccountId | undefined }) {
  const identify = useAtomSet(identifyAccountsAtom, { mode: "promiseExit" });
  const [dialog, setDialog] = useState<{ account: AccountId; kind: AccountDialogKind }>();
  return (
    <>
      <SharedPage
        query={dashboardAtoms.inventory}
        Failure={Failure}
        action={
          <VerifyIdentities
            query={dashboardAtoms.inventory}
            identify={identify}
            Failure={Failure}
          />
        }
        highlight={highlight}
        empty={
          <EmptyState
            title="No accounts yet"
            action={
              <Button asChild>
                <Link to="/apps">Choose an app</Link>
              </Button>
            }
          >
            Open an app to connect an account.
          </EmptyState>
        }
        identityActions={(bindings, inventory) => (
          <IdentityAppPicker bindings={bindings} inventory={inventory}>
            {({ app, requirement, slot, account, onDone, onPendingChange }) => (
              <AppAccountForm
                key={`${app.id}:${slot}`}
                app={app.id}
                version={app.activeVersion}
                scope={requirement.scope}
                requirement={slot}
                provider={{ id: requirement.provider, definition: requirement.definition }}
                initialAccount={account}
                checkWith={requirement.health === true}
                onSaved={onDone}
                onPendingChange={onPendingChange}
              />
            )}
          </IdentityAppPicker>
        )}
        accountActions={(account) => (
          <LocalAccountActions
            account={account}
            open={(kind) => setDialog({ account: account.id, kind })}
          />
        )}
      />
      {dialog && (
        <LocalAccountDialog
          key={`${dialog.account}:${dialog.kind}`}
          id={dialog.account}
          dialog={dialog.kind}
          onClose={() => setDialog(undefined)}
        />
      )}
    </>
  );
}
