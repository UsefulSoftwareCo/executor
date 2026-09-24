import type { SelectedAccounts } from "@executor-js/sdk";
import { ProfileStatus } from "@executor-js/ui/dashboard/profile-status";
import { profileMutations } from "../../contracts/profiles.ts";
import { AsyncResult } from "effect/unstable/reactivity";
import { Failure } from "../components/common.tsx";
import { useAtomValue } from "@effect/atom-react";
import {
  AccountNotFound,
  OAuthReconnectRequired,
  type App,
  type ProfileId,
  type Profile,
} from "@executor-js/sdk";
import type { DashboardAccount } from "@executor-js/local-server/contracts";
import { Cause, Option, Schema } from "effect";
import { ToolBrowser } from "@executor-js/ui/dashboard/tools";
import { HugeiconsIcon } from "@hugeicons/react";
import { Key01Icon } from "@hugeicons/core-free-icons";
import { toolsAtom, toolListAtom } from "../../contracts/api.ts";
import { appToolReadiness, accountSetupFailure } from "../../contracts/dashboard.ts";
import { Button } from "@executor-js/ui/components/button";
import { Link, useNavigate } from "@tanstack/react-router";

interface AppToolsProps {
  readonly app: App;
  readonly selection: SelectedAccounts;
  readonly accounts: ReadonlyArray<DashboardAccount>;
  readonly selected: string | undefined;
  readonly profile?: ProfileId | undefined;
  readonly revision?: number | undefined;
}

function AccountSetup({
  app,
  profile,
  disconnected,
}: Pick<AppToolsProps, "app" | "accounts" | "profile"> & { readonly disconnected: boolean }) {
  return (
    <div className="app-account-setup flex items-center gap-3.5 p-[22px] border border-border rounded-[8px] [&_>_svg]:text-muted-foreground [&_>_svg]:shrink-0 [&_>_div]:flex-1 [&_>_div]:min-w-0 [&_h2]:text-[14px] [&_h2]:font-medium [&_p]:text-[13px] [&_p]:text-muted-foreground [&_p]:mt-1 [&_>_[data-slot='button']]:shrink-0 max-[740px]:flex-wrap max-[740px]:p-[18px] max-[740px]:[&_>_div]:basis-[calc(100%_-_32px)] max-[740px]:[&_>_[data-slot='button']]:ml-8">
      <HugeiconsIcon icon={Key01Icon} strokeWidth={2} size={18} aria-hidden />
      <div>
        <h2>{disconnected ? "Account disconnected" : "Choose an account"}</h2>
        <p>
          {disconnected
            ? "Connect or choose an account to use this app again."
            : "Connect or choose an account to load this app’s tools."}
        </p>
      </div>
      <Button asChild>
        <Link to="/apps/$appId" params={{ appId: app.id }} search={{ view: "accounts", profile }}>
          Choose accounts
        </Link>
      </Button>
    </div>
  );
}

/** Incomplete account setup is a product state; do not start tool discovery until it is resolved. */
function SingleAppTools(props: AppToolsProps) {
  const readiness = appToolReadiness(props.app, props.selection, props.accounts);
  switch (readiness.state) {
    case "not-deployed":
      return (
        <EmptyStatePanel title="No deployment yet">
          Deploy this app to load its tools.
        </EmptyStatePanel>
      );
    case "selection":
      return (
        <AccountSetup
          {...props}
          disconnected={readiness.issues.some((issue) => issue.reason === "disconnected")}
        />
      );
    case "reconnect":
      return <AccountReconnect accounts={readiness.accounts} />;
    case "unavailable":
      return (
        <p role="alert" className="text-sm text-muted-foreground">
          Account status is unavailable. Check Accounts and try again.
        </p>
      );
    case "ready":
      return <LiveAppTools {...props} />;
  }
}

/** An expired sign-in is an account action, not an empty tool browser or retryable request. */
function AccountReconnect({ accounts }: { readonly accounts: ReadonlyArray<DashboardAccount> }) {
  return (
    <div className="accounts-section">
      {accounts.map((account) => (
        <div
          className="app-account-setup flex items-center gap-3.5 p-[22px] border border-border rounded-[8px] [&_>_svg]:text-muted-foreground [&_>_svg]:shrink-0 [&_>_div]:flex-1 [&_>_div]:min-w-0 [&_h2]:text-[14px] [&_h2]:font-medium [&_p]:text-[13px] [&_p]:text-muted-foreground [&_p]:mt-1 [&_>_[data-slot='button']]:shrink-0 max-[740px]:flex-wrap max-[740px]:p-[18px] max-[740px]:[&_>_div]:basis-[calc(100%_-_32px)] max-[740px]:[&_>_[data-slot='button']]:ml-8"
          key={account.id}
        >
          <HugeiconsIcon icon={Key01Icon} strokeWidth={2} size={18} aria-hidden />
          <div>
            <h2>
              {account.label || account.providerName}{" "}
              <span className="sign-in-status text-sign-in-warning text-[11px] font-medium whitespace-nowrap [.app-account-setup_h2_&]:ml-2">
                Needs sign-in
              </span>
            </h2>
            <p>Sign in again to load tools.</p>
          </div>
          <Button asChild>
            <Link to="/accounts/$accountId/credentials" params={{ accountId: account.id }}>
              Reconnect
            </Link>
          </Button>
        </div>
      ))}
    </div>
  );
}

/** Browse the complete live tool catalog with a stable, separate schema inspector. */
function LiveAppTools({ app, accounts, selected, profile, revision, selection }: AppToolsProps) {
  const navigate = useNavigate();
  const atom = toolsAtom({
    app: app.id,
    profile,
    revision,
    deployment: app.activeDeployment,
    accounts: JSON.stringify(selection),
  });
  const result = useAtomValue(atom);
  const setup = AsyncResult.isFailure(result) ? accountSetupFailure(result.cause) : Option.none();
  if (Option.isSome(setup))
    return (
      <AccountSetup
        app={app}
        profile={profile}
        accounts={accounts}
        disconnected={Schema.is(AccountNotFound)(setup.value)}
      />
    );
  const failure = AsyncResult.isFailure(result)
    ? Cause.findErrorOption(result.cause)
    : Option.none();
  const reconnect = Option.isSome(failure)
    ? Option.filter(failure, Schema.is(OAuthReconnectRequired))
    : Option.none();
  if (Option.isSome(reconnect)) {
    const account = accounts.find((account) => account.id === reconnect.value.account);
    if (account !== undefined) return <AccountReconnect accounts={[account]} />;
  }
  return (
    <ToolBrowser
      Failure={Failure}
      key={`${app.id}:${app.activeDeployment}:${profile}:${revision}:${JSON.stringify(selection)}`}
      query={toolListAtom({
        app: app.id,
        profile,
        revision,
        deployment: app.activeDeployment,
        accounts: JSON.stringify(selection),
      })}
      selected={selected}
      onSelect={(tool) => {
        void navigate({
          to: "/apps/$appId",
          params: { appId: app.id },
          search: { view: "tools", tool, profile },
        });
      }}
    />
  );
}

/** The page selects the profile; tools stay in the normal catalog and inspector. */
export function AppTools({
  profile,
  ...props
}: Omit<AppToolsProps, "profile" | "revision" | "selection"> & {
  readonly profile: Profile | undefined;
}) {
  if (profile?.enabled === false || profile?.status === "removing")
    return (
      <p className="p-5 text-sm text-muted-foreground">
        This profile is disabled. Enable it from the profile menu to use its tools.
      </p>
    );
  return (
    <>
      {profile && (
        <ProfileStatus
          profile={profile}
          retry={profileMutations({ app: props.app.id, profile: profile.id }).reconcile}
          Failure={Failure}
        />
      )}
      <SingleAppTools
        {...props}
        selection={profile?.accounts ?? {}}
        profile={profile?.id}
        revision={profile?.revision}
      />
    </>
  );
}
import { EmptyStatePanel } from "@executor-js/ui/dashboard/empty-state";
