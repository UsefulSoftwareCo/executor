import type { AccountSubmission } from "@executor-js/ui/contracts/credentials";
import { useAtomSet } from "@effect/atom-react";
import { useState, type ReactNode } from "react";
import type { Account, AccountScope, AppId, VersionId, Provider } from "@executor-js/sdk";
import { providerDisplayUrl } from "@executor-js/ui/contracts/dashboard";
import { AccountForm as SharedAccountForm } from "@executor-js/ui/dashboard/account-form";
import { accountToNameAtom, checkCredentialsAtom } from "../../contracts/accounts.ts";
import { appConnectionAtoms } from "../../contracts/app-connections.ts";
import type { DashboardError } from "../../contracts/errors.ts";
import { Failure, ProviderIcon } from "../components/common.tsx";
import { AppOAuthFields } from "./oauth-fields.tsx";

export function AppAccountForm({
  app,
  version,
  scope,
  requirement,
  provider,
  account,
  checkWith,
  header,
  actions,
  onSaved,
  onPendingChange,
}: {
  readonly app: AppId;
  readonly version: VersionId | null;
  readonly scope: AccountScope;
  readonly requirement: string;
  readonly provider: Provider;
  readonly account?: Account | undefined;
  readonly checkWith?: boolean;
  readonly header?: ReactNode;
  readonly actions?: ReactNode;
  readonly onSaved: (account: Account) => void;
  readonly onPendingChange?: (pending: boolean) => void;
}) {
  const [atoms] = useState(() =>
    appConnectionAtoms({
      app,
      version,
      scope,
      requirement,
      ...(account === undefined ? {} : { account: account.id }),
    }),
  );
  const submit = useAtomSet(atoms.submit, { mode: "promiseExit" });
  const checkCredentials = useAtomSet(checkCredentialsAtom, { mode: "promiseExit" });
  const requestName = useAtomSet(accountToNameAtom);
  const saved = (saved: Account) => {
    if (account === undefined)
      requestName({ account: saved.id, saved: { account: saved, provider }, app });
    onSaved(saved);
  };
  return (
    <SharedAccountForm<Account, DashboardError>
      provider={provider}
      {...(account ? { account } : {})}
      Failure={Failure}
      submitLabel={account ? "Save credentials" : "Add account"}
      onSaved={saved}
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
            check: {
              app,
              run: (input: AccountSubmission) =>
                checkCredentials({ app, provider: provider.id, ...input }),
            },
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
