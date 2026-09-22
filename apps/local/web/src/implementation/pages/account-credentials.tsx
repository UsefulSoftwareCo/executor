import type { AccountSubmission } from "@executor-js/ui/contracts/credentials";
import { useAtomSet } from "@effect/atom-react";
import type { DashboardAccountDetail } from "@executor-js/local-server/contracts";
import { AccountForm } from "@executor-js/ui/dashboard/account-form";
import { replaceAccountCredentialsAtom } from "../../contracts/accounts.ts";
import { Link, useNavigate } from "@tanstack/react-router";
import { Failure, ProviderIcon } from "../components/common.tsx";
import { OAuthFields } from "./oauth-fields.tsx";

/** Replace credentials without creating another identity or changing any app's selection. */
export function AccountCredentials({
  data: { account, provider },
}: {
  readonly data: DashboardAccountDetail;
}) {
  const navigate = useNavigate();
  const replace = useAtomSet(replaceAccountCredentialsAtom(account.id), { mode: "promiseExit" });
  return (
    <>
      <div className="page-heading gap-4 flex justify-between items-center min-h-12 mb-4.5 [&_p]:text-muted-foreground [&_p]:text-[13px] [&_p]:mt-1.25 [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere max-[740px]:items-start max-[740px]:mb-4.5 max-[740px]:[&_p]:leading-[1.6] max-[740px]:[&_>_[data-slot='button']]:mt-0.25 max-[740px]:[.setup-page_&]:min-h-0">
        <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
          {provider.definition.auth[account.method]?.type === "oauth2"
            ? "Reconnect account"
            : "Update credentials"}
        </h1>
      </div>
      <AccountForm
        provider={provider}
        account={account}
        Failure={Failure}
        submitLabel="Save credentials"
        header={
          <>
            <div className="setup-provider flex items-center gap-3.25 [&_h2]:text-[16px] [&_h2]:[font-weight:550] [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere">
              <ProviderIcon name={account.providerName} url={account.providerUrl} large />
              <h2>{account.label || "Unnamed account"}</h2>
            </div>
            <p className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5] [.mcp-install-content_>_&]:mt-5">
              Apps using this account will use the new credentials.
            </p>
          </>
        }
        actions={
          <Link to="/accounts/$accountId" params={{ accountId: account.id }}>
            Cancel
          </Link>
        }
        submit={({ fields }: AccountSubmission) => replace(fields)}
        onSaved={() => {
          void navigate({ to: "/accounts/$accountId", params: { accountId: account.id } });
        }}
        oauth={(props) => (
          <OAuthFields
            provider={provider}
            account={account}
            onSaved={() => {
              void navigate({ to: "/accounts/$accountId", params: { accountId: account.id } });
            }}
            {...props}
          />
        )}
      />
    </>
  );
}
