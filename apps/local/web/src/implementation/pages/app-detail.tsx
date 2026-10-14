import { AppResources } from "./app-resources.tsx";
import { useState, type ReactNode } from "react";
import { AppAccounts } from "./app-accounts.tsx";
import { AppSkills } from "@executor-js/ui/dashboard/app-skills";
import {
  AppOverviewEntries,
  AppWorkflowPreview,
} from "@executor-js/ui/dashboard/app-overview-entries";
import { appBrowserBindings } from "../../contracts/app-browser.ts";
import { AppSchedules } from "@executor-js/ui/dashboard/schedules";
import { scheduleBindings } from "../../contracts/schedules.ts";
import { allResults, QueryResult, QueryView, useQuery } from "@executor-js/ui/dashboard/context";
import {
  missingRequirements,
  requirementAccounts,
  type RequirementLink,
} from "@executor-js/ui/contracts/app-accounts";
import { useAtomSet } from "@effect/atom-react";
import type { App, AppId } from "@executor-js/sdk";
import type {
  AppAccountLink,
  DashboardAccount,
  DashboardOverview,
} from "@executor-js/local-server/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import { Data, Option } from "effect";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { appAtom, toolsAtom } from "../../contracts/api.ts";
import { appLinksAtom, userLinksAtom } from "../../contracts/app-accounts.ts";
import { renameAppAtom, acknowledgeApp } from "../../contracts/apps.ts";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { Failure } from "../components/common.tsx";
import { Button } from "@executor-js/ui/components/button";
import type { DashboardError } from "../../contracts/errors.ts";
import { RenameApp } from "@executor-js/ui/dashboard/rename-app";
import { CopyApp } from "@executor-js/ui/dashboard/copy-app";
import { AppSettings } from "@executor-js/ui/dashboard/app-settings";
import { AppDetailLayout } from "@executor-js/ui/dashboard/app-detail";
import { AppTools } from "./app-tools.tsx";
import { AppSource, AppDeployments } from "./app-source.tsx";
import {
  AppOverview,
  AppOverviewAccounts,
  AppOverviewTools,
  AppOverviewSource,
} from "@executor-js/ui/dashboard/app-overview";
import { appManagement } from "../../contracts/app-management.ts";
import { AppDetailLoading, OverviewCardLoading } from "@executor-js/ui/dashboard/app-loading";
import { emptyManyRequirements, type AppView } from "@executor-js/ui/contracts/dashboard";
class PreviewKey extends Data.Class<{
  readonly app: AppId;
  readonly deployment: App["activeDeployment"];
}> {}
const overviewToolsAtom = Atom.family((key: PreviewKey) =>
  Atom.map(
    toolsAtom(key),
    AsyncResult.map((data) => ({ items: data.tools })),
  ),
);

/** Views that read only the app. The others also read its linked accounts. */
const appWideViews: ReadonlySet<AppView> = new Set([
  "settings",
  "deployments",
  "source",
  "history",
]);

/** Links with their checks by this app, over the live inventory's sign-in details. */
const withSummaries = (
  links: readonly AppAccountLink[],
  accounts: readonly DashboardAccount[],
): readonly RequirementLink<DashboardAccount>[] =>
  links.flatMap((link) => {
    const summary = accounts.find((item) => item.id === link.account.id);
    return summary === undefined
      ? []
      : [
          {
            requirement: link.requirement,
            account: link.health === undefined ? summary : { ...summary, health: link.health },
          },
        ];
  });

/** Views that run app code use the accounts linked to the app. */
export function AppDetailPage({
  id,
  tab,
  tool,
  overview,
}: {
  readonly id: AppId;
  readonly tab: AppView;
  readonly tool: string | undefined;
  readonly overview: DashboardOverview;
}) {
  const navigate = useNavigate();
  const [skillDirty, setSkillDirty] = useState(false);
  useBlocker({
    shouldBlockFn: () => skillDirty && !window.confirm("Discard your unsaved changes?"),
    enableBeforeUnload: skillDirty,
  });
  const query = useQuery(appAtom(id));
  const appLinks = useQuery(appLinksAtom(id));
  const userLinks = useQuery(userLinksAtom(id));
  const app = Option.isSome(query.data)
    ? query.data.value.app
    : overview.apps.find((item) => item.id === id);
  const missing = (forEveryone: boolean) => (
    <div className="space-y-3 p-5 text-sm text-muted-foreground">
      <p>
        {forEveryone
          ? "This app needs an account linked for everyone. Link one under App accounts in Accounts."
          : "Connect an account in Accounts to start using this app."}
      </p>
      <Button variant="outline" size="sm" asChild>
        <Link to="/apps/$appId" params={{ appId: id }} search={{ view: "accounts" }}>
          Go to Accounts
        </Link>
      </Button>
    </div>
  );
  const pending = <AppDetailLoading view={tab} app={app} selectedTool={tool} />;
  return (
    <AppDetailLayout
      key={id}
      app={app}
      view={tab}
      canInspectSource
      back={
        <Link to="/apps" aria-label="Back to apps">
          <HugeiconsIcon icon={ArrowLeft02Icon} size={15} aria-hidden />
          Apps
        </Link>
      }
      actions={
        Option.isSome(query.data) &&
        query.data.value.uiUrl !== null && (
          <Button variant="outline" asChild>
            <a href={query.data.value.uiUrl} target="_blank" rel="noopener noreferrer">
              Open app{" "}
              <HugeiconsIcon icon={ArrowUpRight01Icon} strokeWidth={2} aria-hidden size={14} />
            </a>
          </Button>
        )
      }
    >
      {appWideViews.has(tab) ? (
        <QueryResult
          result={query.result}
          Failure={Failure}
          retry={query.refresh}
          pending={pending}
        >
          {(current) => {
            if (tab === "settings")
              return (
                <AppSettings
                  app={current.app}
                  copyAction={
                    <CopyApp
                      key={current.app.id}
                      Failure={Failure}
                      app={current.app}
                      atoms={appManagement}
                      onApp={acknowledgeApp}
                      onCopied={(copy) =>
                        navigate({
                          to: "/apps/$appId",
                          params: { appId: copy.id },
                          search: { view: "source" },
                        })
                      }
                    />
                  }
                  renameAction={current.canDelete && <AppRename app={current.app} />}
                  deleteAction={
                    current.canDelete && (
                      <Button variant="destructive" size="sm" asChild>
                        <Link to="/apps/$appId/delete" params={{ appId: id }}>
                          Delete app
                        </Link>
                      </Button>
                    )
                  }
                  notice={
                    !current.canDelete &&
                    "This app is managed by Executor and cannot be renamed or deleted."
                  }
                />
              );
            if (tab === "deployments") return <AppDeployments data={current} />;
            return <AppSource data={current} view={tab === "history" ? "history" : "source"} />;
          }}
        </QueryResult>
      ) : (
        <QueryResult
          result={allResults({
            current: query.result,
            appRows: appLinks.result,
            userRows: userLinks.result,
          })}
          Failure={Failure}
          retry={() => {
            query.refresh();
            appLinks.refresh();
            userLinks.refresh();
          }}
          pending={pending}
        >
          {({ current, appRows, userRows }) => {
            const linked = {
              app: withSummaries(appRows, overview.accounts),
              user: withSummaries(userRows, overview.accounts),
            };
            const requirements = requirementAccounts(current.app, linked);
            const deployment = String(current.app.activeDeployment);
            const ready = missingRequirements(requirements).length === 0;
            const gate = (children: ReactNode) =>
              ready
                ? children
                : missing(
                    missingRequirements(requirements).some(
                      (entry) => entry.requirement.scope === "app",
                    ),
                  );
            if (tab === "skills")
              return gate(
                <AppSkills
                  canEdit
                  app={current.app}
                  bindings={appBrowserBindings(current.app)}
                  Failure={Failure}
                  editing={{
                    atoms: appManagement,
                    onApp: acknowledgeApp,
                    onDirty: setSkillDirty,
                  }}
                />,
              );
            if (tab === "tools")
              return gate(
                <AppTools app={current.app} requirements={requirements} selected={tool} />,
              );
            if (tab === "workflows")
              return gate(<AppResources app={current.app} view="workflows" />);
            if (tab === "webhooks") return <AppResources app={current.app} view="webhooks" />;
            if (tab === "schedules") {
              return (
                <AppSchedules
                  app={current.app}
                  canEdit
                  actor={undefined}
                  bindings={scheduleBindings({ app: current.app.id })}
                  Failure={Failure}
                />
              );
            }
            const previewEmpty = (
              <p className="py-5 text-sm text-muted-foreground">
                Connect an account in Accounts to load this preview.
              </p>
            );
            if (tab === "overview")
              return (
                <AppOverview
                  app={current.app}
                  entries={
                    <AppOverviewEntries
                      app={current.app}
                      bindings={appBrowserBindings(current.app)}
                      workflows={
                        <AppWorkflowPreview
                          empty={previewEmpty}
                          Failure={Failure}
                          sources={
                            ready
                              ? [
                                  {
                                    key: deployment,
                                    query: appBrowserBindings(current.app).workflows,
                                  },
                                ]
                              : []
                          }
                        />
                      }
                      Failure={Failure}
                    />
                  }
                  accounts={<AppOverviewAccounts app={current.app} requirements={requirements} />}
                  tools={
                    <AppOverviewTools
                      app={current.app}
                      Failure={Failure}
                      empty={previewEmpty}
                      accountsNeeded={
                        emptyManyRequirements(requirements).length === requirements.length &&
                        requirements.length > 0
                      }
                      sources={
                        ready
                          ? [
                              {
                                key: deployment,
                                query: overviewToolsAtom(
                                  new PreviewKey({
                                    app: id,
                                    deployment: current.app.activeDeployment,
                                  }),
                                ),
                              },
                            ]
                          : []
                      }
                    />
                  }
                  source={
                    <QueryView
                      query={appManagement.authoring(id)}
                      Failure={Failure}
                      pending={<OverviewCardLoading label="Loading source preview" />}
                    >
                      {(source) => <AppOverviewSource source={source} />}
                    </QueryView>
                  }
                />
              );
            return (
              <div className="max-w-3xl space-y-4 p-5 max-[740px]:p-4">
                <AppAccounts
                  app={current.app}
                  appLinks={linked.app}
                  userLinks={linked.user}
                  accounts={overview.accounts}
                />
              </div>
            );
          }}
        </QueryResult>
      )}
    </AppDetailLayout>
  );
}

/** Local reads update through their existing storage subscriptions. */
function AppRename({ app }: { readonly app: App }) {
  const rename = useAtomSet(renameAppAtom(app.id), { mode: "promiseExit" });
  return <RenameApp<DashboardError> app={app} Failure={Failure} rename={(name) => rename(name)} />;
}
