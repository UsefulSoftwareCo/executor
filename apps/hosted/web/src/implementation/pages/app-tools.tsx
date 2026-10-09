import { AppProviderFailed } from "@executor-js/sdk";
import { ProviderErrorNotice } from "@executor-js/ui/dashboard/provider-error-notice";
import { ProfileStatus } from "@executor-js/ui/dashboard/profile-status";
import { profileMutations } from "../../contracts/profiles.ts";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import type { App, Profile } from "@executor-js/sdk";
import { Cause, Option, Schema } from "effect";
import type { UserFacingError } from "@executor-js/utils/user-facing-error";
import { undeclaredError } from "@executor-js/utils/connection-failure";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ToolBrowser } from "@executor-js/ui/dashboard/tools";
import { ToolRunner, toolRunContext } from "@executor-js/ui/dashboard/tool-runner";
import {
  appToolReadiness,
  unfilledAccountSlots,
  type AccountSummary,
  type FailureProps,
} from "@executor-js/ui/contracts/dashboard";
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

/** Discover and run tools using the selected profile's exact bindings and revision. */
export function AppTools({
  app,
  accounts,
  selected,
  profile,
  label,
}: {
  readonly app: App;
  readonly accounts: readonly AccountSummary[];
  readonly selected: string | undefined;
  readonly profile: Profile | undefined;
  /** The selected profile's name in the page's profile picker. */
  readonly label: string;
}) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const navigate = useNavigate();
  if (profile?.enabled === false || profile?.status === "removing")
    return (
      <p className="p-5 text-sm text-muted-foreground">
        This profile is disabled. Enable it from the profile menu to use its tools.
      </p>
    );
  const readiness = appToolReadiness(app, profile?.accounts ?? {}, accounts);
  const catalog = {
    organization,
    app: app.id,
    profile: profile?.id,
    expectedProfileRevision: profile?.revision,
    deployment: app.activeDeployment ?? undefined,
    accounts: JSON.stringify(profile?.accounts ?? {}),
  };
  if (readiness.state === "not-deployed")
    return <p className="p-5 text-sm text-muted-foreground">Deploy this app to load its tools.</p>;
  const accountsLink = (
    <Link
      to="/org/$organizationSlug/apps/$appId"
      params={{ organizationSlug, appId: app.id }}
      search={{ view: "accounts", profile: profile?.id }}
    >
      Accounts
    </Link>
  );
  if (readiness.state !== "ready")
    return (
      <p className="p-5 text-sm text-muted-foreground">
        Review the selected accounts in {accountsLink} to load tools.
      </p>
    );
  return (
    <>
      {profile && (
        <ProfileStatus
          profile={profile}
          retry={profileMutations({ organization, app: app.id, profile: profile.id }).reconcile}
          Failure={HostedFailure}
        />
      )}
      <ToolBrowser
        key={`${app.id}:${app.activeDeployment}:${profile?.id}:${profile?.revision}:${JSON.stringify(profile?.accounts ?? {})}`}
        query={toolCatalogAtom(catalog)}
        detail={(tool) => toolDetailAtom({ ...catalog, tool: tool.name })}
        Failure={ToolsFailure}
        selected={selected}
        empty={
          unfilledAccountSlots(app, profile?.accounts ?? {}).length > 0 ? (
            <Empty title="No accounts connected">
              This app lists tools for each connected account. Connect one in {accountsLink}.
            </Empty>
          ) : undefined
        }
        onSelect={(tool) => {
          void navigate({
            to: "/org/$organizationSlug/apps/$appId",
            params: { organizationSlug, appId: app.id },
            search: { view: "tools", tool, profile: profile?.id },
          });
        }}
        renderAction={(tool) => (
          <ToolRunner
            key={tool.name}
            tool={tool.name}
            call={callToolAtom({
              organization,
              app: app.id,
              profile: profile?.id,
              expectedProfileRevision: profile?.revision,
              deployment: app.activeDeployment ?? undefined,
              tool: tool.name,
              kind: tool.readOnly === true ? "query" : "mutation",
            })}
            approval={(requestId) => toolRunApprovalAtoms({ organization, app: app.id, requestId })}
            detail={toolDetailAtom({ ...catalog, tool: tool.name })}
            Failure={ToolCallFailure}
            context={
              profile === undefined ? undefined : toolRunContext(label, profile.accounts, accounts)
            }
          />
        )}
      />
    </>
  );
}

/** Tool discovery keeps each expected error's explanation and safe recovery prompt. */
function ToolsFailure<E extends UserFacingError>({ cause, retry, retrying }: FailureProps<E>) {
  const href = useRouterState({ select: (state) => state.location.href });
  const error = Option.getOrElse(Cause.findErrorOption(cause), () => undeclaredError(cause));
  const props = {
    context: `While loading tools for this app and selected profile.\nPage: ${href}`,
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
