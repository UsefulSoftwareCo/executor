import type { DashboardAccountDetail } from "@executor-js/local-server/contracts";
import type { AccountRequirement, AccountScope, App } from "@executor-js/sdk";
import { Button } from "@executor-js/ui/components/button";
import { ProviderIcon } from "../components/common.tsx";
import { AppAccountForm } from "./account-form.tsx";

/**
 * Replace credentials from an app that uses the account. The form shows the app's declaration,
 * so it names the hosts the credentials reach. The account keeps its ID, name and links.
 */
export function ReplaceCredentials({
  data: { account },
  app,
  scope,
  slot,
  requirement,
  onPendingChange,
  onDone,
}: {
  readonly data: DashboardAccountDetail;
  readonly app: App;
  readonly scope: AccountScope;
  readonly slot: string;
  readonly requirement: AccountRequirement;
  readonly onPendingChange?: (pending: boolean) => void;
  readonly onDone: () => void;
}) {
  return (
    <AppAccountForm
      app={app.id}
      deployment={app.activeDeployment}
      scope={scope}
      requirement={slot}
      provider={{ id: requirement.provider, definition: requirement.definition }}
      account={account}
      {...(onPendingChange ? { onPendingChange } : {})}
      header={
        <>
          <div className="setup-provider flex items-center gap-3.25 [&_h2]:text-[16px] [&_h2]:[font-weight:550] [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere">
            <ProviderIcon name={account.providerName} url={account.providerUrl} large />
            <h2>{account.label || "Unnamed account"}</h2>
          </div>
          <p className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5]">
            Apps using this account will use the new credentials.
          </p>
        </>
      }
      actions={
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      }
      onSaved={onDone}
    />
  );
}
