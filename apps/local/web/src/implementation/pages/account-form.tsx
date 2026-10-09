import type { AccountSubmission } from "@executor-js/ui/contracts/credentials";
import { useAtomSet } from "@effect/atom-react";
import { useState, type ReactNode } from "react";
import type { Account, AppId, ProfileId, Provider, SelectedAccounts } from "@executor-js/sdk";
import { providerDisplayUrl } from "@executor-js/ui/contracts/dashboard";
import { AccountForm as SharedAccountForm } from "@executor-js/ui/dashboard/account-form";
import { accountToNameAtom, checkCredentialsAtom } from "../../contracts/accounts.ts";
import { appConnectionAtoms } from "../../contracts/app-connections.ts";
import type { DashboardError } from "../../contracts/errors.ts";
import { Failure, ProviderIcon } from "../components/common.tsx";
import { AppOAuthFields } from "./oauth-fields.tsx";

/**
 * Connect an account for one app requirement, or replace a selected account's credentials. The
 * server saves the account and selects it for the profile together.
 */
export function AppAccountForm({
  app,
  requirement,
  provider,
  profile,
  selection,
  account,
  checkWith,
  header,
  actions,
  onSaved,
  onPendingChange,
}: {
  readonly app: AppId;
  readonly requirement: string;
  readonly provider: Provider;
  readonly profile: ProfileId | undefined;
  /** The shown selection, saved as a new profile when there is none yet. */
  readonly selection: SelectedAccounts;
  /** Replace this account's credentials instead of adding an account. */
  readonly account?: Account | undefined;
  /** Validate entered credentials with the app's check before they are saved. */
  readonly checkWith?: boolean;
  readonly header?: ReactNode;
  readonly actions?: ReactNode;
  readonly onSaved: (account: Account, profile: ProfileId) => void;
  readonly onPendingChange?: (pending: boolean) => void;
}) {
  // One dialog is one attempt; a retry reuses the profile the first attempt created.
  const [atoms] = useState(() =>
    appConnectionAtoms({
      app,
      requirement,
      profile,
      accounts: selection,
      ...(account === undefined ? {} : { account: account.id }),
    }),
  );
  const submit = useAtomSet(atoms.submit, { mode: "promiseExit" });
  const checkCredentials = useAtomSet(checkCredentialsAtom, { mode: "promiseExit" });
  const requestName = useAtomSet(accountToNameAtom);
  // A new account is named once saved; a reconnect keeps its name.
  const saved = (saved: Account, savedProfile: ProfileId) => {
    if (account === undefined)
      requestName({ account: saved.id, saved: { account: saved, provider }, app });
    onSaved(saved, savedProfile);
  };
  return (
    <SharedAccountForm<{ readonly account: Account; readonly profile: ProfileId }, DashboardError>
      provider={provider}
      {...(account ? { account } : {})}
      Failure={Failure}
      submitLabel={account ? "Save credentials" : "Add account"}
      onSaved={(value) => saved(value.account, value.profile)}
      {...(onPendingChange ? { onPendingChange } : {})}
      actions={actions}
      header={
        header ?? (
          <div className="setup-provider flex items-center gap-3.25 [&_h2]:text-[16px] [&_h2]:[font-weight:550] [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere">
            <ProviderIcon
              name={provider.definition.name}
              url={providerDisplayUrl(provider.definition)}
              large
            />
            <h2>{provider.definition.name}</h2>
          </div>
        )
      }
      submit={(input: AccountSubmission) => submit(input)}
      {...(checkWith
        ? {
            check: (input: AccountSubmission) =>
              checkCredentials({ app, provider: provider.id, ...input }),
          }
        : {})}
      oauth={(props) => (
        <AppOAuthFields
          provider={provider}
          app={app}
          atoms={atoms}
          {...(account ? { account } : {})}
          onSaved={saved}
          {...props}
        />
      )}
    />
  );
}
