import { appToolsCatalog } from "../../contracts/app-browser.ts";
import { ToolAccounts } from "@executor-js/ui/dashboard/tool-accounts";
import { Atom, AsyncResult as ToolResult } from "effect/unstable/reactivity";
import { AsyncResult } from "effect/unstable/reactivity";
import { Failure } from "../components/common.tsx";
import { useAtomValue } from "@effect/atom-react";
import { AccountNotFound, OAuthReconnectRequired, type App } from "@executor-js/sdk";
import type { DashboardAccount } from "@executor-js/local-server/contracts";
import { Cause, Option, Schema } from "effect";
import { ToolBrowser } from "@executor-js/ui/dashboard/tools";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon, Key01Icon } from "@hugeicons/core-free-icons";
import { appToolReadiness, accountSetupFailure } from "../../contracts/dashboard.ts";
import { Button } from "@executor-js/ui/components/button";
import { Link, useNavigate } from "@tanstack/react-router";

const toolList = Atom.family((query: ReturnType<typeof appToolsCatalog>) =>
  Atom.map(
    query,
    ToolResult.map((page) => page.items),
  ),
);

interface AppToolsProps {
  readonly app: App;
  readonly accounts: ReadonlyArray<DashboardAccount>;
  readonly selected: string | undefined;
}

function AccountSetup({
  app,
  accounts,
  disconnected,
}: Pick<AppToolsProps, "app" | "accounts"> & { readonly disconnected: boolean }) {
  const requirements = Object.entries(app.requirements.accounts);
  const only = requirements.length === 1 ? requirements[0] : undefined;
  const needsNew =
    only !== undefined &&
    only[1].cardinality === "one" &&
    !accounts.some((account) => account.provider === only[1].provider);
  const destination =
    needsNew && only
      ? ({
          to: "/accounts/add",
          search: { provider: only[1].provider, app: app.id, slot: only[0] },
        } as const)
      : ({ to: "/apps/$appId/setup", params: { appId: app.id } } as const);
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
        <Link {...destination}>
          {needsNew
            ? "Connect account"
            : requirements.length === 1 && only?.[1].cardinality === "one"
              ? "Choose account"
              : "Choose accounts"}
        </Link>
      </Button>
    </div>
  );
}

/** Incomplete account setup is a product state; do not start tool discovery until it is resolved. */
export function AppTools(props: AppToolsProps) {
  const readiness = appToolReadiness(props.app, props.accounts);
  switch (readiness.state) {
    case "not-deployed":
      return <p>Deploy this app to load its tools.</p>;
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
function LiveAppTools({ app, accounts, selected }: AppToolsProps) {
  const navigate = useNavigate();
  const atom = appToolsCatalog(app);
  const result = useAtomValue(atom);
  const setup = AsyncResult.isFailure(result) ? accountSetupFailure(result.cause) : Option.none();
  if (Option.isSome(setup))
    return (
      <AccountSetup
        app={app}
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
      key={`${app.id}:${app.activeDeployment}:${JSON.stringify(app.accounts)}`}
      accountContext={<ToolAccounts app={app} accounts={accounts} />}
      query={toolList(atom)}
      selected={selected}
      onSelect={(tool) => {
        void navigate({
          to: "/apps/$appId",
          params: { appId: app.id },
          search: { view: "tools", tool },
        });
      }}
      back={
        <Link
          className="inline-flex min-h-11 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          to="/apps/$appId"
          params={{ appId: app.id }}
          search={{ view: "tools" }}
        >
          <HugeiconsIcon icon={ArrowLeft02Icon} size={16} />
          All tools
        </Link>
      }
    />
  );
}
