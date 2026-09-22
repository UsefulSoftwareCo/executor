import { profileMutations } from "../../contracts/profiles.ts";
import { Failure } from "../components/common.tsx";
import { AccountSelectionDialog } from "./account-selection-dialog.tsx";
import { Link } from "@tanstack/react-router";
import { Button } from "@executor-js/ui/components/button";
import {
  AppAccounts as SharedAccounts,
  AccountSelectionTrigger,
  RemoveAccountBinding,
} from "@executor-js/ui/dashboard/app-accounts";
import type { App, Profile, ProfileId } from "@executor-js/sdk";
import type { DashboardOverview } from "@executor-js/local-server/contracts";

/** Show profile bindings with local destinations for reconnecting a saved account. */
export function AppAccounts({
  app,
  data,
  profile,
  onSelected,
  onCreateProfile,
}: {
  readonly onSelected: (id: ProfileId) => void;
  readonly onCreateProfile?: (() => void) | undefined;
  readonly app: App;
  readonly data: DashboardOverview;
  readonly profile: Profile | undefined;
}) {
  return (
    <SharedAccounts
      app={{ ...app, accounts: { ...app.accounts, ...profile?.accounts } }}
      accounts={data.accounts}
      onCreateProfile={onCreateProfile}
      removeAccountAction={(slot, account, label) =>
        profile !== undefined &&
        !Object.hasOwn(app.accounts, slot) && (
          <RemoveAccountBinding
            profile={profile}
            slot={slot}
            account={account}
            label={label}
            update={profileMutations({ app: app.id, profile: profile.id }).update}
            Failure={Failure}
          />
        )
      }
      accountActions={(slot, requirement) =>
        !Object.hasOwn(app.accounts, slot) && (
          <AccountSelectionDialog
            app={app}
            data={data}
            onSelected={onSelected}
            profile={profile?.id}
            slot={slot}
            trigger={
              <AccountSelectionTrigger
                requirement={requirement}
                selection={profile?.accounts[slot]}
              />
            }
          />
        )
      }
      reconnectAction={(account) => (
        <Button variant="outline" size="sm" asChild>
          <Link to="/accounts/$accountId/credentials" params={{ accountId: account.id }}>
            Reconnect
          </Link>
        </Button>
      )}
    />
  );
}
