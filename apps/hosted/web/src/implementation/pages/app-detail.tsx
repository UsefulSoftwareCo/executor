import { AppAccessSettings } from "./resource-settings.tsx";
import { appAccessAtom } from "../../contracts/resource-access.ts";
import type { AppView } from "@executor-js/ui/contracts/dashboard";
import { AppSchedules } from "@executor-js/ui/dashboard/schedules";
import { scheduleBindings } from "../../contracts/schedules.ts";
import {
  AppDetailLoading,
  AppSettingsLoading,
  OverviewCardLoading,
} from "@executor-js/ui/dashboard/app-loading";
import { Exit, Option } from "effect";
import { HostedFailure, useDashboardAtoms } from "../components/dashboard-bindings.tsx";
import { useAtomSet } from "@effect/atom-react";
import { AppId, type App } from "@executor-js/sdk";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@executor-js/ui/components/button";
import type { HostedError } from "../../contracts/errors.ts";
import { RenameApp } from "@executor-js/ui/dashboard/rename-app";
import { CopyApp } from "@executor-js/ui/dashboard/copy-app";
import { PublishApp } from "@executor-js/ui/dashboard/publish-app";
import { AppSettings } from "@executor-js/ui/dashboard/app-settings";
import { AppDetailLayout } from "@executor-js/ui/dashboard/app-detail";
import {
  AppOverview,
  AppOverviewAccounts,
  AppOverviewTools,
  AppOverviewSource,
} from "@executor-js/ui/dashboard/app-overview";
import { appManagement } from "../../contracts/app-management.ts";
import { AppAccounts } from "@executor-js/ui/dashboard/app-accounts";
import { QueryView, QueryResult, useQuery } from "@executor-js/ui/dashboard/context";
import {
  appAtom,
  acknowledgeApp,
  appError,
  removeAppAtom,
  renameAppAtom,
  toolsAtom,
} from "../../contracts/apps.ts";
import { useOrganizationRoute } from "../components/organization.tsx";
import { AppTools } from "./app-tools.tsx";
import { AppSource, AppDeployments } from "./app-source.tsx";

/** Host routing and permissions surround the common local detail frame. */
export function AppDetailPage({
  appId,
  view,
  tool,
  openApp,
}: {
  readonly appId: string;
  readonly view?: AppView | undefined;
  readonly tool?: string | undefined;
  readonly openApp?: (app: App) => ReactNode;
}) {
  const { organization, role, slug: organizationSlug } = useOrganizationRoute();
  const navigate = useNavigate();
  const atoms = useDashboardAtoms();
  const inventory = useQuery(atoms.inventory);
  const { result, data, refresh } = useQuery(appAtom({ organization, app: AppId.make(appId) }));
  const app = Option.isSome(data)
    ? data.value
    : Option.isSome(inventory.data)
      ? inventory.data.value.apps.find((item) => item.id === appId)
      : undefined;
  const selectedView = view ?? (tool === undefined ? "overview" : "tools");
  const authority = useQuery(appAccessAtom({ organization, app: AppId.make(appId) }));
  const access = Option.isSome(authority.data) ? authority.data.value : undefined;
  const canInspectSource = access?.canManage === true;
  const canUse = access?.canUse === true;
  const pending = (
    <AppDetailLoading
      view={selectedView}
      app={app}
      canInspectSource={canInspectSource}
      selectedTool={tool}
    />
  );
  return (
    <AppDetailLayout
      key={appId}
      app={app}
      view={selectedView}
      canInspectSource={canInspectSource}
      back={
        <Link
          to="/org/$organizationSlug/apps"
          params={{ organizationSlug }}
          aria-label="Back to apps"
        >
          <HugeiconsIcon icon={ArrowLeft02Icon} size={15} aria-hidden />
          Apps
        </Link>
      }
      actions={
        app && (
          <>
            {canUse && openApp?.(app)}
            {canInspectSource && (
              <>
                {(role === "owner" || role === "admin") && (
                  <PublishApp
                    app={app}
                    atoms={appManagement(organization)}
                    Failure={HostedFailure}
                  />
                )}
                <CopyApp
                  key={app.id}
                  Failure={HostedFailure}
                  app={app}
                  atoms={appManagement(organization)}
                  onApp={(get, saved) => acknowledgeApp(get, organization, saved)}
                  onCopied={(copy) =>
                    navigate({
                      to: "/org/$organizationSlug/apps/$appId",
                      params: { organizationSlug, appId: copy.id },
                      search: { view: "source" },
                    })
                  }
                />
              </>
            )}
          </>
        )
      }
    >
      <QueryResult
        result={authority.result}
        Failure={HostedFailure}
        retry={authority.refresh}
        pending={pending}
      >
        {() => (
          <QueryResult result={result} Failure={HostedFailure} retry={refresh} pending={pending}>
            {(current) =>
              selectedView === "schedules" ? (
                <AppSchedules
                  bindings={scheduleBindings({ organization, app: current.id }, canInspectSource)}
                  Failure={HostedFailure}
                />
              ) : selectedView === "overview" ? (
                <AppOverview
                  app={current}
                  tools={
                    <QueryResult
                      result={inventory.result}
                      Failure={HostedFailure}
                      retry={inventory.refresh}
                      pending={
                        <>
                          <div className="mb-1 flex min-h-9 items-center border-b pb-3">
                            <h3 className="text-sm font-medium">Tools</h3>
                          </div>
                          <OverviewCardLoading label="Loading tools preview" />
                        </>
                      }
                    >
                      {(inventory) =>
                        canUse ? (
                          <AppOverviewTools
                            app={current}
                            accounts={inventory.accounts}
                            query={toolsAtom({ organization, app: current.id })}
                            Failure={HostedFailure}
                          />
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            This app is not shared with you. You can manage its settings.
                          </p>
                        )
                      }
                    </QueryResult>
                  }
                  accounts={
                    <QueryResult
                      result={inventory.result}
                      Failure={HostedFailure}
                      retry={inventory.refresh}
                      pending={<OverviewCardLoading label="Loading accounts preview" />}
                    >
                      {(inventory) => (
                        <AppOverviewAccounts app={current} accounts={inventory.accounts} />
                      )}
                    </QueryResult>
                  }
                  source={
                    canInspectSource && (
                      <QueryView
                        query={appManagement(organization).source(current.id)}
                        Failure={HostedFailure}
                        pending={<OverviewCardLoading label="Loading source preview" />}
                      >
                        {(source) => <AppOverviewSource source={source} />}
                      </QueryView>
                    )
                  }
                />
              ) : selectedView === "settings" ? (
                access === undefined ? (
                  <AppSettingsLoading app={current} />
                ) : (
                  <AppSettings
                    app={current}
                    renameAction={canInspectSource && <AppRename app={current} />}
                    deleteAction={canInspectSource && <DeleteApp app={current} />}
                    notice={
                      !canInspectSource &&
                      "The app creator and organization admins can rename or delete this app."
                    }
                  >
                    <section className="rounded-lg border p-5">
                      <AppAccessSettings app={current.id} />
                    </section>
                  </AppSettings>
                )
              ) : selectedView === "source" ||
                selectedView === "history" ||
                selectedView === "deployments" ? (
                access === undefined ? (
                  <AppDetailLoading
                    view={selectedView}
                    app={current}
                    canInspectSource={canInspectSource}
                  />
                ) : !canInspectSource ? (
                  <p className="p-5 text-sm text-muted-foreground">
                    The app creator and organization admins can inspect app source.
                  </p>
                ) : selectedView === "deployments" ? (
                  <AppDeployments key={current.id} app={current} />
                ) : (
                  <AppSource key={current.id} app={current} view={selectedView} />
                )
              ) : current.activeDeployment === null ? (
                <p className="p-5 text-sm text-muted-foreground">
                  Deploy this app before using its tools or selecting accounts.
                </p>
              ) : (
                <QueryResult
                  result={inventory.result}
                  Failure={HostedFailure}
                  retry={inventory.refresh}
                  pending={pending}
                >
                  {(inventory) =>
                    selectedView === "tools" ? (
                      canUse ? (
                        <AppTools app={current} accounts={inventory.accounts} selected={tool} />
                      ) : (
                        <p className="p-5 text-sm text-muted-foreground">
                          This app is not shared with you. You can manage its settings.
                        </p>
                      )
                    ) : (
                      <AppAccounts
                        app={current}
                        accounts={inventory.accounts}
                        chooseAction={
                          canInspectSource && (
                            <Button variant="outline" size="sm" asChild>
                              <Link
                                to="/org/$organizationSlug/apps/$appId/setup"
                                params={{ organizationSlug, appId }}
                              >
                                Choose accounts
                              </Link>
                            </Button>
                          )
                        }
                      />
                    )
                  }
                </QueryResult>
              )
            }
          </QueryResult>
        )}
      </QueryResult>
    </AppDetailLayout>
  );
}

function DeleteApp({ app }: { readonly app: App }) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const remove = useAtomSet(removeAppAtom({ organization, app: app.id }), { mode: "promiseExit" });
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  return confirm ? (
    <div className="delete-confirm max-w-85 text-[13px] [&_.form-actions]:mt-2.5">
      <p>
        Delete {app.name} and its app data? Saved accounts and copies installed by others are kept.
      </p>
      <div className="form-actions flex items-center gap-5 pt-1 text-[13px] [&_a]:text-muted-foreground max-[740px]:[&_>_a]:min-h-11 max-[740px]:[&_>_a]:inline-flex max-[740px]:[&_>_a]:items-center max-[740px]:flex-wrap max-[740px]:gap-[12px_20px]">
        <Button
          variant="destructive"
          loading={pending}
          onClick={async () => {
            setPending(true);
            const result = await remove();
            setPending(false);
            if (Exit.isFailure(result)) setError(appError(result.cause));
            else {
              await navigate({ to: "/org/$organizationSlug/apps", params: { organizationSlug } });
            }
          }}
        >
          Delete
        </Button>
        <Button variant="outline" onClick={() => setConfirm(false)}>
          Cancel
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  ) : (
    <Button variant="destructive" size="sm" onClick={() => setConfirm(true)}>
      Delete app
    </Button>
  );
}

/** The mutation acknowledges shared metadata before the dialog closes. */
function AppRename({ app }: { readonly app: App }) {
  const { organization } = useOrganizationRoute();
  const rename = useAtomSet(renameAppAtom({ organization, app: app.id }), { mode: "promiseExit" });
  return <RenameApp<HostedError> app={app} Failure={HostedFailure} rename={rename} />;
}
