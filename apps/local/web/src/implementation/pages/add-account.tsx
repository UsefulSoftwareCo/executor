import type { AccountSubmission } from "@executor-js/ui/contracts/credentials";
import { useAtomSet } from "@effect/atom-react";
import { useState } from "react";
import type { Account, Provider, ProviderId } from "@executor-js/sdk";
import type { OAuthAppReturn } from "../../contracts/oauth.ts";
import type { DashboardOverview } from "@executor-js/local-server/contracts";
import { providerDisplayUrl } from "@executor-js/ui/contracts/dashboard";
import { AccountForm as SharedAccountForm } from "@executor-js/ui/dashboard/account-form";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon, ArrowRight02Icon } from "@hugeicons/core-free-icons";
import type { AddAccountSearch } from "../../contracts/navigation.ts";
import { addAccountAtom, installedProviders } from "../../contracts/onboarding.ts";
import { Link, useNavigate } from "@tanstack/react-router";
import { Empty, Failure, ProviderIcon } from "../components/common.tsx";
import { Button } from "@executor-js/ui/components/button";
import { OAuthFields } from "./oauth-fields.tsx";

/** Save reusable account metadata through the local API. */
export function AccountForm({
  provider,
  onSaved,
  returnTo,
  onPendingChange,
}: {
  readonly provider: Provider;
  readonly onSaved: (account: Account) => void;
  readonly returnTo?: Omit<typeof OAuthAppReturn.Type, "connection">;
  readonly onPendingChange?: (pending: boolean) => void;
}) {
  const add = useAtomSet(addAccountAtom, { mode: "promiseExit" });
  return (
    <SharedAccountForm
      provider={provider}
      Failure={Failure}
      submitLabel="Add account"
      onSaved={onSaved}
      {...(onPendingChange ? { onPendingChange } : {})}
      header={
        <div className="setup-provider flex items-center gap-3.25 [&_h2]:text-[16px] [&_h2]:[font-weight:550] [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere">
          <ProviderIcon
            name={provider.definition.name}
            url={providerDisplayUrl(provider.definition)}
            large
          />
          <h2>{provider.definition.name}</h2>
        </div>
      }
      submit={(input: AccountSubmission) => add({ payload: { provider: provider.id, ...input } })}
      oauth={(props) => (
        <OAuthFields
          provider={provider}
          onSaved={onSaved}
          {...(returnTo ? { returnTo } : {})}
          {...props}
        />
      )}
    />
  );
}

/** A standalone account selects its provider from apps already installed on this host. */
export function AddAccountPage({
  data,
  provider: initial,
  app,
  slot,
  profile,
}: {
  readonly data: DashboardOverview;
} & AddAccountSearch) {
  const navigate = useNavigate();
  const providers = installedProviders(data);
  const [selected, setSelected] = useState<ProviderId | undefined>(initial);
  const provider = providers.find((provider) => provider.id === selected);
  const back = app
    ? ({ to: "/apps/$appId/setup", params: { appId: app }, search: { profile } } as const)
    : ({ to: "/accounts" } as const);
  return (
    <div className="page setup-page w-full shrink-0 [padding:24px_24px_48px] my-0 mx-auto max-[1000px]:[padding:20px_20px_40px] max-w-212.5 max-[740px]:[padding:18px_max(16px,_env(safe-area-inset-right))_max(32px,_env(safe-area-inset-bottom))_max(16px,_env(safe-area-inset-left))]">
      <Link
        className="back-link inline-flex gap-1.5 items-center text-[12px] text-muted-foreground mb-4.25 hover:text-foreground max-[740px]:min-h-11 max-[740px]:inline-flex max-[740px]:items-center max-[740px]:-mt-2 max-[740px]:mb-3"
        {...back}
      >
        <HugeiconsIcon icon={ArrowLeft02Icon} strokeWidth={2} aria-hidden size={14} />
        {app ? "Account selection" : "Accounts"}
      </Link>
      <div className="page-heading gap-4 flex justify-between items-center min-h-12 mb-4.5 [&_p]:text-muted-foreground [&_p]:text-[13px] [&_p]:mt-1.25 [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere max-[740px]:items-start max-[740px]:mb-4.5 max-[740px]:[&_p]:leading-[1.6] max-[740px]:[&_>_[data-slot='button']]:mt-0.25 max-[740px]:[.setup-page_&]:min-h-0">
        <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
          Add account
        </h1>
      </div>
      {provider ? (
        <>
          <AccountForm
            key={provider.id}
            provider={provider}
            onSaved={(account) => {
              void navigate(
                app && slot
                  ? {
                      to: "/apps/$appId/setup",
                      params: { appId: app },
                      search: { selected: account.id, slot, profile },
                    }
                  : { to: "/accounts" },
              );
            }}
          />
          {!initial && (
            <Button variant="ghost" onClick={() => setSelected(undefined)}>
              Choose another provider
            </Button>
          )}
        </>
      ) : providers.length ? (
        <div className="provider-list max-w-145 flex flex-col">
          {providers.map((provider) => (
            <button
              className="provider-choice flex items-center gap-3.5 py-[16px] px-0 border-b border-b-border text-left cursor-pointer [&_span:nth-child(2)]:flex-1 hover:text-muted-foreground max-[740px]:min-w-0 max-[740px]:[&_span:nth-child(2)]:min-w-0 max-[740px]:[&_span:nth-child(2)]:wrap-anywhere"
              key={provider.id}
              onClick={() => setSelected(provider.id)}
            >
              <ProviderIcon
                name={provider.definition.name}
                url={providerDisplayUrl(provider.definition)}
              />
              <span>{provider.definition.name}</span>
              <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} aria-hidden size={14} />
            </button>
          ))}
        </div>
      ) : (
        <Empty title="Add an app first">
          Account sign-in methods come from installed apps. <Link to="/apps/add">Browse apps</Link>
        </Empty>
      )}
    </div>
  );
}
