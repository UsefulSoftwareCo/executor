import { EmptyStatePanel } from "@executor-js/ui/dashboard/empty-state";
import { Skeleton } from "@executor-js/ui/components/skeleton";
import { AppSkills } from "@executor-js/ui/dashboard/app-skills";
import { AppWorkflows } from "@executor-js/ui/dashboard/app-workflows";
import { AppOverviewEntries } from "@executor-js/ui/dashboard/app-overview-entries";
import { appBrowserBindings, appToolsCatalog } from "../../contracts/app-browser.ts";
import { AppSchedules } from "@executor-js/ui/dashboard/schedules";
import { scheduleBindings } from "../../contracts/schedules.ts";
import { QueryResult, QueryView, useQuery } from "@executor-js/ui/dashboard/context";
import { useAtomSet } from "@effect/atom-react";
import type { App, AppId } from "@executor-js/sdk";
import type { DashboardOverview } from "@executor-js/local-server/contracts";
import { Option } from "effect";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { appAtom } from "../../contracts/api.ts";
import { renameAppAtom, acknowledgeApp } from "../../contracts/apps.ts";
import { Link, useNavigate } from "@tanstack/react-router";
import { Failure } from "../components/common.tsx";
import { Button } from "@executor-js/ui/components/button";
import type { DashboardError } from "../../contracts/errors.ts";
import { RenameApp } from "@executor-js/ui/dashboard/rename-app";
import { CopyApp } from "@executor-js/ui/dashboard/copy-app";
import { AppSettings } from "@executor-js/ui/dashboard/app-settings";
import { AppDetailLayout } from "@executor-js/ui/dashboard/app-detail";
import { AppTools } from "./app-tools.tsx";
import { AppAccounts } from "./app-accounts.tsx";
import { AppSource, AppDeployments } from "./app-source.tsx";
import {
  AppOverview,
  AppOverviewAccounts,
  AppOverviewTools,
  AppOverviewSource,
} from "@executor-js/ui/dashboard/app-overview";
import { appManagement } from "../../contracts/app-management.ts";
import { AppDetailLoading, OverviewCardLoading } from "@executor-js/ui/dashboard/app-loading";

import type { AppView } from "@executor-js/ui/contracts/dashboard";

/** Inspect a configured app without conflating its live tools with retained source versions. */
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
  const { result, data, refresh } = useQuery(appAtom(id));
  const app = Option.isSome(data) ? data.value.app : overview.apps.find((item) => item.id === id);
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
        <>
          {Option.isSome(data) && data.value.uiUrl !== null && (
            <Button variant="outline" asChild>
              <a href={data.value.uiUrl} target="_blank" rel="noopener noreferrer">
                Open app{" "}
                <HugeiconsIcon icon={ArrowUpRight01Icon} strokeWidth={2} aria-hidden size={14} />
              </a>
            </Button>
          )}
          {app && (
            <CopyApp
              key={app.id}
              Failure={Failure}
              app={app}
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
          )}
        </>
      }
    >
      <QueryResult
        result={result}
        Failure={Failure}
        retry={refresh}
        pending={
          <AppDetailLoading
            view={tab}
            app={app}
            canInspectSource
            selectedTool={tool}
            accountAction={<Skeleton className="h-9 w-36 max-[740px]:h-11" />}
          />
        }
      >
        {(current) =>
          tab === "skills" ? (
            <AppSkills
              app={current.app}
              bindings={appBrowserBindings(current.app)}
              Failure={Failure}
            />
          ) : tab === "workflows" ? (
            <AppWorkflows
              app={current.app}
              bindings={appBrowserBindings(current.app)}
              Failure={Failure}
            />
          ) : tab === "schedules" ? (
            <AppSchedules bindings={scheduleBindings({ app: id })} Failure={Failure} />
          ) : tab === "overview" ? (
            <AppOverview
              app={current.app}
              entries={
                <AppOverviewEntries
                  app={current.app}
                  bindings={appBrowserBindings(current.app)}
                  Failure={Failure}
                />
              }
              tools={
                <AppOverviewTools
                  app={current.app}
                  accounts={overview.accounts}
                  query={appToolsCatalog(current.app)}
                  Failure={Failure}
                />
              }
              accounts={<AppOverviewAccounts app={current.app} accounts={overview.accounts} />}
              source={
                <QueryView
                  query={appManagement.source(current.app.id)}
                  Failure={Failure}
                  pending={
                    <OverviewCardLoading
                      label="Loading source preview"
                      rows={2}
                      description={false}
                    />
                  }
                >
                  {(source) => <AppOverviewSource source={source} />}
                </QueryView>
              }
            />
          ) : tab === "settings" ? (
            <AppSettings
              app={current.app}
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
          ) : tab === "deployments" ? (
            <AppDeployments data={current} />
          ) : tab === "source" || tab === "history" ? (
            <AppSource data={current} view={tab} />
          ) : current.app.activeDeployment === null ? (
            <EmptyStatePanel title="No deployment yet">
              Deploy this app before using its tools or selecting accounts.
            </EmptyStatePanel>
          ) : tab === "tools" ? (
            <AppTools app={current.app} accounts={overview.accounts} selected={tool} />
          ) : (
            <AppAccounts app={current.app} accounts={overview.accounts} />
          )
        }
      </QueryResult>
    </AppDetailLayout>
  );
}

/** Local reads update through their existing storage subscriptions. */
function AppRename({ app }: { readonly app: App }) {
  const rename = useAtomSet(renameAppAtom(app.id), { mode: "promiseExit" });
  return <RenameApp<DashboardError> app={app} Failure={Failure} rename={(name) => rename(name)} />;
}
