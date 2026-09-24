import { AccountAccessSettings } from "./resource-settings.tsx";
import { DetailSkeleton } from "@executor-js/ui/dashboard/loading";
import type { AccountDetail } from "@executor-js/ui/contracts/dashboard";
import { useAtomSet } from "@effect/atom-react";
import { AccountId } from "@executor-js/sdk";
import { Link, useNavigate } from "@tanstack/react-router";
import { Exit, type Cause } from "effect";
import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";
import { AccountDetails, DisconnectAccount } from "@executor-js/ui/dashboard/account-detail";
import { QueryView } from "@executor-js/ui/dashboard/context";
import { Button } from "@executor-js/ui/components/button";
import {
  accountAtom,
  disconnectAccountAtom,
  reconnectAccountAtom,
  renameAccountAtom,
} from "../../contracts/accounts.ts";
import type { HostedError } from "../../contracts/errors.ts";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";

/** Hosted products share the local account view without importing local auth or transport. */
export function AccountDetailPage({
  id,
  view = "details",
}: {
  readonly id: string;
  readonly view?: "details" | "disconnect";
}) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const account = AccountId.make(id);
  return (
    <section className="page setup-page w-full shrink-0 [padding:24px_24px_48px] my-0 mx-auto max-[1000px]:[padding:20px_20px_40px] max-w-212.5 max-[740px]:[padding:18px_max(16px,_env(safe-area-inset-right))_max(32px,_env(safe-area-inset-bottom))_max(16px,_env(safe-area-inset-left))]">
      <Link
        className="back-link inline-flex gap-1.5 items-center text-[12px] text-muted-foreground mb-4.25 hover:text-foreground max-[740px]:min-h-11 max-[740px]:inline-flex max-[740px]:items-center max-[740px]:-mt-2 max-[740px]:mb-3"
        to={
          view === "details"
            ? "/org/$organizationSlug/accounts"
            : "/org/$organizationSlug/accounts/$accountId"
        }
        params={{ organizationSlug, accountId: id }}
      >
        <HugeiconsIcon icon={ArrowLeft02Icon} size={14} />
        {view === "details" ? "Accounts" : "Account"}
      </Link>
      <QueryView
        pending={<DetailSkeleton label="Loading account" />}
        query={accountAtom({ organization, account })}
        Failure={HostedFailure}
      >
        {(data) => <AccountView key={id} data={data} view={view} />}
      </QueryView>
    </section>
  );
}
function AccountView({
  data,
  view,
}: {
  readonly data: AccountDetail;
  readonly view: "details" | "disconnect";
}) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const account = data.account.id;
  const params = { organization, account };
  const navigate = useNavigate();
  const rename = useAtomSet(renameAccountAtom(params), { mode: "promiseExit" });
  const disconnect = useAtomSet(disconnectAccountAtom(params), { mode: "promiseExit" });
  const reconnect = useAtomSet(reconnectAccountAtom, { mode: "promiseExit" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<HostedError>>();
  const canManage = data.canManage;
  if (view === "disconnect")
    return canManage ? (
      <DisconnectAccount
        title="Delete account?"
        submitLabel="Delete account"
        impact={
          <p className="text-sm text-muted-foreground">
            This account and its app selections will be removed. Other selected accounts stay
            connected.
          </p>
        }
        data={data}
        Failure={HostedFailure}
        disconnect={() => disconnect()}
        onDisconnected={() => {
          void navigate({ to: "/org/$organizationSlug/accounts", params: { organizationSlug } });
        }}
        cancel={
          <Link
            to="/org/$organizationSlug/accounts/$accountId"
            params={{ organizationSlug, accountId: account }}
          >
            Cancel
          </Link>
        }
      />
    ) : (
      <p>You do not have permission to delete this account.</p>
    );
  return (
    <AccountDetails<HostedError>
      data={{ ...data, canManage }}
      Failure={HostedFailure}
      readOnlyMessage="Only the account creator and organization admins can manage this shared account."
      rename={rename}
      signInAction={
        <>
          {error && <HostedFailure cause={error} />}
          <Button
            variant="outline"
            loading={pending}
            disabledReason={
              canManage
                ? undefined
                : "Only the account creator and organization admins can update its credentials."
            }
            onClick={async () => {
              setPending(true);
              setError(undefined);
              const result = await reconnect(params);
              setPending(false);
              if (Exit.isFailure(result)) {
                setError(result.cause);
                return;
              }
              // Open the dialog over this page; the handoff route would unmount it.
              await navigate({
                to: "/org/$organizationSlug/accounts/$accountId",
                params: { organizationSlug, accountId: account },
                search: { connection: result.value.id },
              });
            }}
          >
            {data.provider.definition.auth[data.account.method]?.type === "oauth2"
              ? "Reconnect"
              : "Update credentials"}
          </Button>
        </>
      }
      disconnectAction={
        <Button
          variant="destructive"
          asChild
          disabledReason={
            canManage
              ? undefined
              : "Only the account creator and organization admins can delete this shared account."
          }
        >
          <Link
            to="/org/$organizationSlug/accounts/$accountId/disconnect"
            params={{ organizationSlug, accountId: account }}
          >
            Delete account
          </Link>
        </Button>
      }
    >
      <AccountAccessSettings account={account} />
    </AccountDetails>
  );
}
