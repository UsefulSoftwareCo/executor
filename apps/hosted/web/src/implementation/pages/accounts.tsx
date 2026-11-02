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
import {
  type OrganizationPageReads,
  useOrganizationDetails,
  useOrganizationRoute,
} from "../components/organization.tsx";
import { OAuthClientsDialog } from "./oauth-clients.tsx";
import { resourceDirectoryAtom, resourceInventoryAtom } from "../../contracts/resource-access.ts";

/** The organization's account directory. */
export const accountsPageReads: OrganizationPageReads = (organization) => [
  resourceDirectoryAtom(organization),
];

/**
 * Personal and shared credentials use one list. Administrators also manage the organization's
 * OAuth clients from here, since those clients only exist to connect accounts.
 */
export function AccountsPage({
  highlight,
  oauthClients,
}: {
  readonly highlight?: AccountId | undefined;
  readonly oauthClients: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void };
}) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const directory = useQuery(resourceDirectoryAtom(organization));
  const [dialog, setDialog] = useState<{ account: AccountId; kind: AccountDialogKind }>();
  const role = useOrganizationDetails()?.role;
  const admin = role !== undefined && role !== "member";
  const manageClients = admin && (
    <Button variant="outline" onClick={() => oauthClients.onOpenChange(true)}>
      OAuth clients
    </Button>
  );
  return (
    <>
      <SharedPage
        query={resourceInventoryAtom(organization)}
        Failure={HostedFailure}
        action={manageClients}
        empty={
          <EmptyState
            title="No accounts available"
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button asChild>
                  <Link to="/org/$organizationSlug/apps" params={{ organizationSlug }}>
                    Choose an app
                  </Link>
                </Button>
                {manageClients}
              </div>
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
      {admin && <OAuthClientsDialog {...oauthClients} />}
    </>
  );
}
