import { useState } from "react";
import type { AccountId } from "@executor-js/sdk";
import {
  HostedAccountActions,
  HostedAccountDialog,
  type AccountDialogKind,
} from "./account-actions.tsx";
import { Option } from "effect";
import { AccountsPage as SharedPage } from "@executor-js/ui/dashboard/accounts";
import { EmptyState } from "@executor-js/ui/dashboard/empty-state";
import { Button } from "@executor-js/ui/components/button";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@executor-js/ui/dashboard/context";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";
import { resourceDirectoryAtom, resourceInventoryAtom } from "../../contracts/resource-access.ts";
/** Personal and shared credentials use one list. */
export function AccountsPage({ highlight }: { readonly highlight?: AccountId | undefined }) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const directory = useQuery(resourceDirectoryAtom(organization));
  const [dialog, setDialog] = useState<{ account: AccountId; kind: AccountDialogKind }>();
  return (
    <>
      <SharedPage
        query={resourceInventoryAtom(organization)}
        Failure={HostedFailure}
        empty={
          <EmptyState
            title="No accounts available"
            action={
              <Button asChild>
                <Link to="/org/$organizationSlug/apps" params={{ organizationSlug }}>
                  Choose an app
                </Link>
              </Button>
            }
          >
            Open an app to connect an account, or ask a teammate to share one.
          </EmptyState>
        }
        highlight={highlight}
        accountActions={(account) => {
          const entry = Option.isSome(directory.data)
            ? directory.data.value.accounts.find((item) => item.account.id === account.id)
            : undefined;
          return (
            <HostedAccountActions
              account={account}
              access={entry?.access}
              open={(kind) => setDialog({ account: account.id, kind })}
            />
          );
        }}
        accountMeta={(account) => {
          const access = Option.isSome(directory.data)
            ? directory.data.value.accounts.find((item) => item.account.id === account.id)?.access
            : undefined;
          return (
            access && (
              <span className="rounded border px-1.5 py-0.5 text-[10px]">
                {access.ownership.kind === "personal" ? "Personal" : "Shared"}
              </span>
            )
          );
        }}
      />
      {dialog && (
        <HostedAccountDialog
          key={`${dialog.account}:${dialog.kind}`}
          id={dialog.account}
          dialog={dialog.kind}
          onClose={() => setDialog(undefined)}
        />
      )}
    </>
  );
}
