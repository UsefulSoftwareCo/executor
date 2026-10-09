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
  const [dialog, setDialog] = useState<{ account: AccountId; kind: AccountDialogKind }>();
  return (
    <>
      <SharedPage
        query={dashboardAtoms.inventory}
        Failure={Failure}
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
