import { AppProviderFailed, type App } from "@executor-js/sdk";
import { ProviderErrorNotice } from "@executor-js/ui/dashboard/provider-error-notice";
import { Cause, Option, Schema } from "effect";
import type { UserFacingError } from "@executor-js/utils/user-facing-error";
import { undeclaredError } from "@executor-js/utils/connection-failure";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ToolBrowser } from "@executor-js/ui/dashboard/tools";
import { runningAs, ToolRunner } from "@executor-js/ui/dashboard/tool-runner";
import {
  appToolReadiness,
  emptyManyRequirements,
  type AccountSummary,
  type FailureProps,
} from "@executor-js/ui/contracts/dashboard";
import type { RequirementAccounts } from "@executor-js/ui/contracts/app-accounts";
import { ErrorNotice } from "@executor-js/ui/dashboard/error-notice";
import { Empty } from "@executor-js/ui/dashboard/common";
import { AppSectionHeader, AppSectionTitle } from "@executor-js/ui/dashboard/app-section-header";
import {
  appError,
  callToolAtom,
  toolDetailAtom,
  toolCatalogAtom,
  toolRunApprovalAtoms,
} from "../../contracts/apps.ts";
import type { HostedError } from "../../contracts/errors.ts";
import { useOrganizationRoute } from "../components/organization.tsx";

/** Discover and run tools with the accounts linked to the app. */
export function AppTools({
  app,
  requirements,
  selected,
}: {
  readonly app: App;
  readonly requirements: readonly RequirementAccounts<AccountSummary>[];
  readonly selected: string | undefined;
}) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const navigate = useNavigate();
  const readiness = appToolReadiness(app, requirements);
  const catalog = {
    organization,
    app: app.id,
    deployment: app.activeDeployment ?? undefined,
  };
  if (readiness.state === "not-deployed")
    return <p className="p-5 text-sm text-muted-foreground">Deploy this app to load its tools.</p>;
  const accountsLink = (
    <Link
      to="/org/$organizationSlug/apps/$appId"
      params={{ organizationSlug, appId: app.id }}
      search={{ view: "accounts" }}
    >
      Accounts
    </Link>
  );
  if (readiness.state !== "ready")
    return (
      <p className="p-5 text-sm text-muted-foreground">
        Review the linked accounts in {accountsLink} to load tools.
      </p>
    );
  return (
    <ToolBrowser
      key={`${app.id}:${app.activeDeployment}`}
      query={toolCatalogAtom(catalog)}
      detail={(tool) => toolDetailAtom({ ...catalog, tool: tool.name })}
      Failure={ToolsFailure}
      selected={selected}
      empty={
        emptyManyRequirements(requirements).length > 0 ? (
          <Empty title="No accounts linked">
            This app lists tools for each linked account. Link one in {accountsLink}.
          </Empty>
        ) : undefined
      }
      onSelect={(tool) => {
        void navigate({
          to: "/org/$organizationSlug/apps/$appId",
          params: { organizationSlug, appId: app.id },
          search: { view: "tools", tool },
        });
      }}
      renderAction={(tool) => (
        <ToolRunner
          key={tool.name}
          tool={tool.name}
          call={callToolAtom({
            organization,
            app: app.id,
            deployment: app.activeDeployment ?? undefined,
            tool: tool.name,
            kind: tool.readOnly === true ? "query" : "mutation",
          })}
          approval={(requestId) => toolRunApprovalAtoms({ organization, app: app.id, requestId })}
          detail={toolDetailAtom({ ...catalog, tool: tool.name })}
          Failure={ToolCallFailure}
          accounts={runningAs(requirements)}
        />
      )}
    />
  );
}

/** Tool discovery keeps each expected error's explanation and safe recovery prompt. */
function ToolsFailure<E extends UserFacingError>({ cause, retry, retrying }: FailureProps<E>) {
  const href = useRouterState({ select: (state) => state.location.href });
  const error = Option.getOrElse(Cause.findErrorOption(cause), () => undeclaredError(cause));
  const props = {
    context: `While loading tools for this app and its accounts.\nPage: ${href}`,
    retry,
    retrying,
    retryStatus: "Checking tools",
    layout: "panel" as const,
  };
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <AppSectionHeader>
        <AppSectionTitle>Tools</AppSectionTitle>
      </AppSectionHeader>
      <div className="flex flex-1 items-start justify-center px-6 py-12 max-[740px]:px-4 max-[740px]:py-6">
        <div className="w-full max-w-lg">
          {Schema.is(AppProviderFailed)(error) ? (
            <ProviderErrorNotice {...props} error={error} />
          ) : (
            <ErrorNotice {...props} error={error} />
          )}
        </div>
      </div>
    </div>
  );
}
/** Tool failures keep the hosted API's safe copy; provider failures are shared by the runner. */
function ToolCallFailure({ cause }: FailureProps<HostedError>) {
  return (
    <p role="alert" className="text-destructive text-[13px]">
      {appError(cause)}
    </p>
  );
}
