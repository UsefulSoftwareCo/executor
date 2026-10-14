import type { AppId } from "@executor-js/sdk";
import { AsyncResult } from "effect/reactivity";
import { Failure } from "../components/common.tsx";
import { useAtomValue } from "@effect/atom-react";
import { AccountNotFound, OAuthReconnectRequired, type App } from "@executor-js/sdk";
import type { DashboardAccount } from "@executor-js/local-server/contracts";
import { Cause, Option, Schema } from "effect";
import { ToolBrowser } from "@executor-js/ui/dashboard/tools";
import { runningAs, ToolRunner } from "@executor-js/ui/dashboard/tool-runner";
import type { RequirementAccounts } from "@executor-js/ui/contracts/app-accounts";
import { emptyManyRequirements } from "@executor-js/ui/contracts/dashboard";
import { HugeiconsIcon } from "@hugeicons/react";
import { Key01Icon } from "@hugeicons/core-free-icons";
import {
  callToolAtom,
  toolDetailAtom,
  toolsAtom,
  toolCatalogAtom,
  toolRunApprovalAtoms,
} from "../../contracts/api.ts";
import { appToolReadiness, accountSetupFailure } from "../../contracts/dashboard.ts";
import { Button } from "@executor-js/ui/components/button";
import { Link, useNavigate } from "@tanstack/react-router";

interface AppToolsProps {
  readonly app: App;
  /** The app's requirements with their linked accounts. */
  readonly requirements: readonly RequirementAccounts<DashboardAccount>[];
  readonly selected: string | undefined;
}

function AccountSetup({
  app,
  disconnected,
}: {
  readonly app: App;
  readonly disconnected: boolean;
}) {
  return (
    <div className="app-account-setup flex items-center gap-3.5 p-[22px] border border-border rounded-[8px] [&_>_svg]:text-muted-foreground [&_>_svg]:shrink-0 [&_>_div]:flex-1 [&_>_div]:min-w-0 [&_h2]:text-[14px] [&_h2]:font-medium [&_p]:text-[13px] [&_p]:text-muted-foreground [&_p]:mt-1 [&_>_[data-slot='button']]:shrink-0 max-[740px]:flex-wrap max-[740px]:p-[18px] max-[740px]:[&_>_div]:basis-[calc(100%_-_32px)] max-[740px]:[&_>_[data-slot='button']]:ml-8">
      <HugeiconsIcon icon={Key01Icon} strokeWidth={2} size={18} aria-hidden />
      <div>
        <h2>{disconnected ? "Account disconnected" : "Connect an account"}</h2>
        <p>
          {disconnected
            ? "Connect an account to use this app again."
            : "Connect an account to load this app’s tools."}
        </p>
      </div>
      <Button asChild>
        <Link to="/apps/$appId" params={{ appId: app.id }} search={{ view: "accounts" }}>
          View accounts
        </Link>
      </Button>
    </div>
  );
}

/** Incomplete account setup is a product state; do not start tool discovery until it is resolved. */
export function AppTools(props: AppToolsProps) {
  const readiness = appToolReadiness(props.app, props.requirements);
  switch (readiness.state) {
    case "not-deployed":
      return (
        <EmptyStatePanel title="No deployment yet">
          Deploy this app to load its tools.
        </EmptyStatePanel>
      );
    case "missing":
      return <AccountSetup app={props.app} disconnected={false} />;
    case "reconnect":
      return (
        <AccountReconnect app={props.app.id} accounts={readiness.accounts} status="Needs sign-in" />
      );
    case "rejected":
      return (
        <AccountReconnect
          app={props.app.id}
          accounts={readiness.accounts}
          status="Sign-in rejected"
        />
      );
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
function AccountReconnect({
  app,
  accounts,
  status,
}: {
  readonly app: AppId;
  readonly accounts: ReadonlyArray<DashboardAccount>;
  readonly status: string;
}) {
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
                {status}
              </span>
            </h2>
            <p>Sign in again to load tools.</p>
          </div>
          <Button asChild>
            <Link to="/apps/$appId" params={{ appId: app }} search={{ view: "accounts" }}>
              Reconnect
            </Link>
          </Button>
        </div>
      ))}
    </div>
  );
}

/** Browse the complete live tool catalog with a stable, separate schema inspector. */
function LiveAppTools({ app, requirements, selected }: AppToolsProps) {
  const navigate = useNavigate();
  const catalog = { app: app.id, deployment: app.activeDeployment };
  const atom = toolsAtom(catalog);
  const result = useAtomValue(atom);
  const setup = AsyncResult.isFailure(result) ? accountSetupFailure(result.cause) : Option.none();
  if (Option.isSome(setup))
    return <AccountSetup app={app} disconnected={Schema.is(AccountNotFound)(setup.value)} />;
  const failure = AsyncResult.isFailure(result)
    ? Cause.findErrorOption(result.cause)
    : Option.none();
  const reconnect = Option.isSome(failure)
    ? Option.filter(failure, Schema.is(OAuthReconnectRequired))
    : Option.none();
  if (Option.isSome(reconnect)) {
    const account = requirements
      .flatMap((entry) => entry.linked)
      .find((account) => account.id === reconnect.value.account);
    if (account !== undefined)
      return <AccountReconnect app={app.id} accounts={[account]} status="Needs sign-in" />;
  }
  return (
    <ToolBrowser
      Failure={Failure}
      key={`${app.id}:${app.activeDeployment}`}
      query={toolCatalogAtom(catalog)}
      detail={(tool) => toolDetailAtom({ ...catalog, tool: tool.name })}
      selected={selected}
      empty={
        emptyManyRequirements(requirements).length > 0 ? (
          <AccountSetup app={app} disconnected={false} />
        ) : undefined
      }
      onSelect={(tool) => {
        void navigate({
          to: "/apps/$appId",
          params: { appId: app.id },
          search: { view: "tools", tool },
        });
      }}
      renderAction={(tool) => (
        <ToolRunner
          key={tool.name}
          tool={tool.name}
          call={callToolAtom({
            app: app.id,
            deployment: app.activeDeployment ?? undefined,
            tool: tool.name,
            kind: tool.readOnly === true ? "query" : "mutation",
          })}
          approval={(requestId) => toolRunApprovalAtoms({ app: app.id, requestId })}
          detail={toolDetailAtom({ ...catalog, tool: tool.name })}
          Failure={Failure}
          accounts={runningAs(requirements)}
        />
      )}
    />
  );
}

import { EmptyStatePanel } from "@executor-js/ui/dashboard/empty-state";
