import type { DashboardError } from "../../contracts/errors.ts";
import { AccountDetails as SharedDetails } from "@executor-js/ui/dashboard/account-detail";
import { QueryView } from "@executor-js/ui/dashboard/context";
import { useAtomSet } from "@effect/atom-react";
import type { AccountId } from "@executor-js/sdk";
import type { DashboardAccountDetail } from "@executor-js/local-server/contracts";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";
import { accountAtom, renameAccountAtom } from "../../contracts/accounts.ts";
import { Link } from "@tanstack/react-router";
import { Failure, LoadingRows } from "../components/common.tsx";
import { Button } from "@executor-js/ui/components/button";
import { AccountCredentials } from "./account-credentials.tsx";
import { DisconnectAccount } from "./disconnect-account.tsx";

/** Account routes share safe metadata loading, with separate full-page credential and disconnect flows. */
export function AccountDetailPage({
  id,
  view,
}: {
  readonly id: AccountId;
  readonly view: "details" | "credentials" | "disconnect";
}) {
  return (
    <div className="page setup-page w-full shrink-0 [padding:24px_24px_48px] my-0 mx-auto max-[1000px]:[padding:20px_20px_40px] max-w-212.5 max-[740px]:[padding:18px_max(16px,_env(safe-area-inset-right))_max(32px,_env(safe-area-inset-bottom))_max(16px,_env(safe-area-inset-left))]">
      <Link
        className="back-link inline-flex gap-1.5 items-center text-[12px] text-muted-foreground mb-4.25 hover:text-foreground max-[740px]:min-h-11 max-[740px]:inline-flex max-[740px]:items-center max-[740px]:-mt-2 max-[740px]:mb-3"
        to={view === "details" ? "/accounts" : "/accounts/$accountId"}
        params={{ accountId: id }}
      >
        <HugeiconsIcon icon={ArrowLeft02Icon} strokeWidth={2} aria-hidden size={14} />
        {view === "details" ? "Accounts" : "Account"}
      </Link>
      <QueryView key={id} query={accountAtom(id)} Failure={Failure} pending={<LoadingRows />}>
        {(data) =>
          view === "details" ? (
            <AccountDetails key={id} data={data} />
          ) : !data.canManage ? (
            <p>This account is managed by the local server.</p>
          ) : view === "credentials" ? (
            <AccountCredentials key={id} data={data} />
          ) : (
            <DisconnectAccount key={id} data={data} />
          )
        }
      </QueryView>
    </div>
  );
}

function AccountDetails({ data }: { readonly data: DashboardAccountDetail }) {
  const rename = useAtomSet(renameAccountAtom(data.account.id), { mode: "promiseExit" });
  const { account, provider } = data;
  return (
    <SharedDetails<DashboardError>
      data={data}
      Failure={Failure}
      readOnlyMessage="Managed by the local server."
      rename={rename}
      signInAction={
        <Button
          variant="outline"
          asChild
          disabledReason={
            data.canManage ? undefined : "This account is managed by the local server."
          }
        >
          <Link to="/accounts/$accountId/credentials" params={{ accountId: account.id }}>
            {provider.definition.auth[account.method]?.type === "oauth2"
              ? "Reconnect"
              : "Update credentials"}
          </Link>
        </Button>
      }
      disconnectAction={
        <Button
          variant="ghost"
          className="text-destructive"
          asChild
          disabledReason={
            data.canManage ? undefined : "This account is managed by the local server."
          }
        >
          <Link to="/accounts/$accountId/disconnect" params={{ accountId: account.id }}>
            Disconnect account
          </Link>
        </Button>
      }
    />
  );
}
