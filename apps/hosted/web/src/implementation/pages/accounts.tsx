import { VerifyIdentities } from "@executor-js/ui/dashboard/verify-identities";
import { useAtomSet } from "@effect/atom-react";
import { identifyAccountsAtom } from "../../contracts/accounts.ts";
import { IdentityAppPicker } from "@executor-js/ui/dashboard/identity-app-picker";
import { AppConnectionDialogContent } from "./app-accounts.tsx";
import { useState } from "react";
import type { AccountId } from "@executor-js/sdk";
import {
  HostedAccountActions,
  HostedAccountDialog,
  type AccountDialogKind,
} from "./account-actions.tsx";
import { AccountsPage as SharedPage } from "@executor-js/ui/dashboard/accounts";
import { EmptyState } from "@executor-js/ui/dashboard/empty-state";
import { Button } from "@executor-js/ui/components/button";
import { Link } from "@tanstack/react-router";
import { Option } from "effect";
import { usePreload, useQuery } from "@executor-js/ui/dashboard/context";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import {
  type OrganizationPageReads,
  useOrganizationDetails,
  useOrganizationRoute,
} from "../components/organization.tsx";
import { OAuthClientsDialog } from "./oauth-clients.tsx";
import { inventoryAtom } from "../../contracts/organization.ts";
import { resourceInventoryAtom } from "../../contracts/resource-access.ts";

export const accountsPageReads: OrganizationPageReads = (organization) => [
  resourceInventoryAtom(organization),
  inventoryAtom(organization),
];
export function AccountsPage({
  highlight,
  oauthClients,
}: {
  readonly highlight?: AccountId | undefined;
  readonly oauthClients: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void };
}) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  usePreload(...accountsPageReads(organization, {}));
  const identify = useAtomSet(identifyAccountsAtom(organization), { mode: "promiseExit" });
  const setup = useQuery(inventoryAtom(organization));
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
        action={
          <>
            <VerifyIdentities
              query={resourceInventoryAtom(organization)}
              identify={identify}
              Failure={HostedFailure}
            />
            {manageClients}
          </>
        }
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
            Open an app to connect your own account.
          </EmptyState>
        }
        highlight={highlight}
        identityActions={(bindings, inventory) => {
          const ready = Option.getOrUndefined(setup.data);
          return (
            ready !== undefined && (
              <IdentityAppPicker bindings={bindings} inventory={inventory}>
                {({ app, requirement, slot, method, account, onDone, onPendingChange }) => (
                  <AppConnectionDialogContent
                    key={`${app.id}:${slot}`}
                    app={app}
                    scope={requirement.scope}
                    slot={slot}
                    requirement={requirement}
                    method={method}
                    initialAccount={account}
                    redirectUri={ready.accountSetup.redirectUri}
                    onSaved={onDone}
                    onPendingChange={onPendingChange}
                  />
                )}
              </IdentityAppPicker>
            )
          );
        }}
        accountActions={(account) => {
          return (
            <HostedAccountActions
              account={account}
              open={(kind) => setDialog({ account: account.id, kind })}
            />
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
