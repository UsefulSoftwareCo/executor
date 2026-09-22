import { AppResources } from "./app-resources.tsx";
import { useEffect, useState } from "react";
import { AppAccounts } from "./app-accounts.tsx";
import { ProfileResources } from "@executor-js/ui/dashboard/profile-resources";
import { AppSkills } from "@executor-js/ui/dashboard/app-skills";
import {
  AppOverviewEntries,
  AppWorkflowPreview,
} from "@executor-js/ui/dashboard/app-overview-entries";
import { appBrowserBindings } from "../../contracts/app-browser.ts";
import {
  profilesAtom,
  accountSelectionAtom,
  profileMutations,
  profileWebhooksAtom,
} from "../../contracts/profiles.ts";
import { accountContexts, selectedAccountContext } from "@executor-js/ui/dashboard/account-group";
import { SetupDialog } from "@executor-js/ui/dashboard/setup-dialog";
import { ProfilePicker } from "@executor-js/ui/dashboard/profile-picker";
import { ProfileStatus } from "@executor-js/ui/dashboard/profile-status";
import { AppSchedules } from "@executor-js/ui/dashboard/schedules";
import { scheduleBindings } from "../../contracts/schedules.ts";
import { QueryResult, QueryView, useQuery } from "@executor-js/ui/dashboard/context";
import { useAtomSet } from "@effect/atom-react";
import type { App, AppId, ProfileId } from "@executor-js/sdk";
import type { DashboardOverview } from "@executor-js/local-server/contracts";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { Data, Option } from "effect";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { appAtom, toolsAtom } from "../../contracts/api.ts";
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
import { AppSource, AppDeployments } from "./app-source.tsx";
import {
  AppOverview,
  AppOverviewAccounts,
  AppOverviewTools,
  AppOverviewSource,
} from "@executor-js/ui/dashboard/app-overview";
import { appManagement } from "../../contracts/app-management.ts";
import { AppDetailLoading, OverviewCardLoading } from "@executor-js/ui/dashboard/app-loading";
import { accountSelectionIssues, type AppView } from "@executor-js/ui/contracts/dashboard";
class PreviewKey extends Data.Class<{
  readonly app: AppId;
  readonly deployment: App["activeDeployment"];
  readonly accounts: string;
  readonly profile?: ProfileId | undefined;
  readonly revision?: number | undefined;
}> {}
const overviewToolsAtom = Atom.family((key: PreviewKey) =>
  Atom.map(
    toolsAtom(key),
    AsyncResult.map((data) => ({ items: data.tools })),
  ),
);

/** One selected profile supplies runtime bindings across the app page. */
export function AppDetailPage({
  id,
  tab,
  tool,
  overview,
  profile,
}: {
  readonly id: AppId;
  readonly tab: AppView;
  readonly tool: string | undefined;
  readonly overview: DashboardOverview;
  readonly profile?: ProfileId | undefined;
}) {
  const navigate = useNavigate();
  const query = useQuery(appAtom(id));
  const app = Option.isSome(query.data)
    ? query.data.value.app
    : overview.apps.find((item) => item.id === id);
  const setups = useQuery(profilesAtom({ app: id }));
  const [setupRequest, setSetupRequest] = useState<string>();
  const inventoryData = overview;
  const choices =
    app && inventoryData && Option.isSome(setups.data)
      ? accountContexts(app, setups.data.value, true)
      : [];
  const selected = selectedAccountContext(choices, profile);
  const selectedId = selected?.profile?.id;
  const personal =
    app !== undefined &&
    Object.keys(app.requirements.accounts).some((slot) => !Object.hasOwn(app.accounts, slot));
  useEffect(() => {
    if (profile === undefined && selectedId !== undefined) {
      void navigate({
        to: "/apps/$appId",
        params: { appId: id },
        search: { view: tab, tool, profile: selectedId },
        replace: true,
      });
    }
  }, [profile, selectedId, navigate, id, tab, tool]);
  const select = (selectedProfile: ProfileId | undefined, nextView: AppView = tab) => {
    void navigate({
      to: "/apps/$appId",
      params: { appId: id },
      search: { view: nextView, profile: selectedProfile },
    });
  };
  const empty = (
    <div className="space-y-3 p-5 text-sm text-muted-foreground">
      <p>
        {profile !== undefined
          ? "This profile is unavailable. Choose another profile in Accounts."
          : "Choose accounts in Accounts to start using this app."}
      </p>
      <Button variant="outline" size="sm" onClick={() => select(undefined, "accounts")}>
        Go to Accounts
      </Button>
    </div>
  );
  const setupActions = app && selected?.profile && (
    <ProfileResources
      key={selected.key}
      profile={selected.profile}
      label={selected.label}
      update={profileMutations({ app: id, profile: selected.profile.id }).update}
      hooks={profileWebhooksAtom({
        app: id,
        profile: selected.profile.id,
      })}
      Failure={Failure}
      setupLink={(hook) => (
        <Button variant="outline" size="sm" asChild>
          <a href={`/webhooks/${app.id}/${hook.id}`}>Complete setup</a>
        </Button>
      )}
    />
  );
  const pending = <AppDetailLoading view={tab} app={app} canInspectSource selectedTool={tool} />;
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
      setupPicker={
        choices.length > 1 && (
          <ProfilePicker
            contexts={choices}
            selected={selected}
            onSelect={(context) => select(context.profile?.id)}
            management={
              selected?.profile
                ? {
                    setEnabled: profileMutations({
                      app: selected.app.id,
                      profile: selected.profile.id,
                    }).setEnabled,
                    remove: profileMutations({
                      app: selected.app.id,
                      profile: selected.profile.id,
                    }).remove,
                    Failure: Failure,
                    onRemoved: () => select(undefined, "accounts"),
                  }
                : undefined
            }
          />
        )
      }
      actions={
        <>
          {Option.isSome(query.data) &&
            query.data.value.uiUrl !== null &&
            selected !== undefined && (
              <Button variant="outline" asChild>
                <a
                  href={
                    selectedId === undefined
                      ? query.data.value.uiUrl
                      : new URL(
                          `?profile=${encodeURIComponent(selectedId)}`,
                          query.data.value.uiUrl,
                        ).href
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open app{" "}
                  <HugeiconsIcon icon={ArrowUpRight01Icon} strokeWidth={2} aria-hidden size={14} />
                </a>
              </Button>
            )}
        </>
      }
    >
      {setupRequest && app && inventoryData && (
        <SetupDialog
          key={setupRequest}
          app={app}
          mutation={accountSelectionAtom({
            app: app.id,
            target: { kind: "new", request: setupRequest },
          })}
          Failure={Failure}
          onClose={() => setSetupRequest(undefined)}
          onSaved={(saved) => select(saved.id, "accounts")}
        />
      )}
      <QueryResult result={query.result} Failure={Failure} retry={query.refresh} pending={pending}>
        {(current) => {
          if (tab === "skills")
            return (
              <AppSkills
                canEdit
                app={current.app}
                bindings={appBrowserBindings(current.app)}
                Failure={Failure}
              />
            );
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
          if (tab === "source" || tab === "history") return <AppSource data={current} view={tab} />;
          return (
            <QueryResult
              result={setups.result}
              Failure={Failure}
              retry={setups.refresh}
              pending={pending}
            >
              {(entries) => {
                const contexts = accountContexts(current.app, entries);
                const previewContexts = contexts.filter(
                  (context) => accountSelectionIssues(context.app, overview.accounts).length === 0,
                );
                const previewEmpty =
                  contexts.length > 0 ? (
                    <p className="py-5 text-sm text-muted-foreground">
                      Finish account setup in Accounts to load this preview.
                    </p>
                  ) : (
                    empty
                  );
                const context = selectedAccountContext(
                  accountContexts(current.app, entries, true),
                  profile,
                );
                if (tab === "tools")
                  return context === undefined ? (
                    empty
                  ) : (
                    <AppTools
                      key={context.key}
                      app={context.app}
                      profile={context.profile}
                      accounts={overview.accounts}
                      selected={tool}
                    />
                  );
                if (tab === "workflows" || tab === "webhooks")
                  return context === undefined ? (
                    empty
                  ) : (
                    <AppResources key={context.key} context={context} view={tab} editable />
                  );
                if (tab === "schedules")
                  return context === undefined ? (
                    empty
                  ) : (
                    <AppSchedules
                      app={current.app}
                      canEdit
                      key={context.key}
                      enabled={context.profile?.enabled !== false}
                      bindings={scheduleBindings(
                        { app: current.app.id, profile: context.profile?.id },
                        context.profile?.enabled !== false,
                      )}
                      Failure={Failure}
                    />
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
                              sources={previewContexts.map((context) => ({
                                key: context.key,
                                query: appBrowserBindings(context.app, context.profile).workflows,
                              }))}
                            />
                          }
                          Failure={Failure}
                        />
                      }
                      accounts={
                        <AppOverviewAccounts
                          app={current.app}
                          contexts={contexts}
                          accounts={overview.accounts}
                        />
                      }
                      tools={
                        <AppOverviewTools
                          app={current.app}
                          Failure={Failure}
                          empty={previewEmpty}
                          sources={previewContexts.map((context) => ({
                            key: context.key,
                            query: overviewToolsAtom(
                              new PreviewKey({
                                app: id,
                                deployment: current.app.activeDeployment,
                                accounts: JSON.stringify(current.app.accounts),
                                profile: context.profile?.id,
                                revision: context.profile?.revision,
                              }),
                            ),
                          }))}
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
                return context === undefined && profile !== undefined ? (
                  empty
                ) : (
                  <div className="max-w-3xl p-5 max-[740px]:p-4">
                    <AppAccounts
                      key={context?.key ?? "default"}
                      app={current.app}
                      profile={context?.profile}
                      data={overview}
                      onSelected={(id) => select(id, "accounts")}
                      onCreateProfile={
                        personal ? () => setSetupRequest(crypto.randomUUID()) : undefined
                      }
                    />
                    {context?.profile && (
                      <ProfileStatus
                        profile={context.profile}
                        retry={
                          profileMutations({
                            app: current.app.id,
                            profile: context.profile.id,
                          }).reconcile
                        }
                        Failure={Failure}
                      />
                    )}
                    {setupActions}
                  </div>
                );
              }}
            </QueryResult>
          );
        }}
      </QueryResult>
    </AppDetailLayout>
  );
}

/** Local reads update through their existing storage subscriptions. */
function AppRename({ app }: { readonly app: App }) {
  const rename = useAtomSet(renameAppAtom(app.id), { mode: "promiseExit" });
  return <RenameApp<DashboardError> app={app} Failure={Failure} rename={(name) => rename(name)} />;
}
