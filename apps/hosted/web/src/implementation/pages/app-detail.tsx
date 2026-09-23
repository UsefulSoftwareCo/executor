import { AppResources } from "./app-resources.tsx";
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
import { AppAccessSettings } from "./resource-settings.tsx";
import { appAccessAtom } from "../../contracts/resource-access.ts";
import { accountSelectionIssues, type AppView } from "@executor-js/ui/contracts/dashboard";
import { AppSchedules } from "@executor-js/ui/dashboard/schedules";
import { scheduleBindings } from "../../contracts/schedules.ts";
import { AppDetailLoading, OverviewCardLoading } from "@executor-js/ui/dashboard/app-loading";
import { Exit, Option } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { HostedFailure, useDashboardAtoms } from "../components/dashboard-bindings.tsx";
import { useAtomSet } from "@effect/atom-react";
import { AppId, type App, type Profile, type ProfileId } from "@executor-js/sdk";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@executor-js/ui/components/button";
import { Skeleton } from "@executor-js/ui/components/skeleton";
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
import type { parseAppSearch } from "../../contracts/navigation.ts";
import { QueryView, QueryResult, useQuery } from "@executor-js/ui/dashboard/context";
import {
  toolsAtom,
  liveAppAtom,
  acknowledgeApp,
  appError,
  removeAppAtom,
  renameAppAtom,
} from "../../contracts/apps.ts";
import { useOrganizationRoute } from "../components/organization.tsx";
import { AppTools } from "./app-tools.tsx";
import { AppSource, AppDeployments } from "./app-source.tsx";

/** One selected profile supplies runtime bindings across the app page. */
export function AppDetailPage({
  appId,
  view,
  tool,
  openApp,
  profile,
}: {
  readonly appId: string;
  readonly view?: AppView | undefined;
  readonly tool?: string | undefined;
  readonly openApp?: (app: App, selected?: Profile) => ReactNode;
  readonly profile?: ProfileId | undefined;
}) {
  const { organization, role, slug: organizationSlug } = useOrganizationRoute();
  const navigate = useNavigate();
  const atoms = useDashboardAtoms();
  const inventory = useQuery(atoms.inventory);
  const query = useQuery(liveAppAtom({ organization, app: AppId.make(appId) }));
  const app = Option.isSome(query.data)
    ? query.data.value
    : Option.isSome(inventory.data)
      ? inventory.data.value.apps.find((item) => item.id === appId)
      : undefined;
  const selectedView = view ?? (tool === undefined ? "overview" : "tools");
  const setups = useQuery(profilesAtom({ organization, app: AppId.make(appId) }));
  const authority = useQuery(appAccessAtom({ organization, app: AppId.make(appId) }));
  const access = Option.getOrUndefined(authority.data);
  const canManage = access?.canManage === true,
    canUse = access?.canUse === true;
  const accessPendingReason = AsyncResult.isFailure(authority.result)
    ? "App access could not be checked. Retry the access request."
    : "Checking app access…";
  const manageReason =
    access === undefined
      ? accessPendingReason
      : canManage
        ? undefined
        : "Only the app creator and organization admins can manage this app.";
  const sourceReason =
    access === undefined
      ? accessPendingReason
      : canManage
        ? undefined
        : "Only the app creator and organization admins can view app source and deployments.";
  const [setupRequest, setSetupRequest] = useState<string>();
  const inventoryData = Option.isSome(inventory.data) ? inventory.data.value : undefined;
  const choices =
    app && inventoryData && Option.isSome(setups.data)
      ? accountContexts(app, setups.data.value, true)
      : [];
  const selected = selectedAccountContext(choices, profile);
  const selectedId = selected?.profile?.id;
  const personal = app !== undefined && Object.keys(app.requirements.accounts).length > 0;
  useEffect(() => {
    if (profile === undefined && selectedId !== undefined) {
      void navigate({
        to: "/org/$organizationSlug/apps/$appId",
        params: { organizationSlug, appId },
        search: (previous: ReturnType<typeof parseAppSearch>) => ({
          ...previous,
          view: selectedView,
          tool,
          profile: selectedId,
        }),
        replace: true,
      });
    }
  }, [profile, selectedId, navigate, appId, selectedView, tool, organizationSlug]);
  const select = (id: ProfileId | undefined, nextView: AppView = selectedView) => {
    void navigate({
      to: "/org/$organizationSlug/apps/$appId",
      params: { organizationSlug, appId },
      search: { view: nextView, profile: id },
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
      update={
        profileMutations({
          organization,
          app: app.id,
          profile: selected.profile.id,
        }).update
      }
      hooks={profileWebhooksAtom({
        organization,
        app: app.id,
        profile: selected.profile.id,
      })}
      Failure={HostedFailure}
      setupLink={(hook) => (
        <Button variant="outline" size="sm" asChild>
          <a href={`/org/${organizationSlug}/webhooks/${app.id}/${hook.id}`}>Complete setup</a>
        </Button>
      )}
    />
  );
  const pending = <AppDetailLoading view={selectedView} app={app} selectedTool={tool} />;
  return (
    <AppDetailLayout
      key={appId}
      app={app}
      view={selectedView}
      canInspectSource={canManage}
      sourceDisabledReason={sourceReason}
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
      setupPicker={
        choices.length > 1 &&
        canUse && (
          <ProfilePicker
            contexts={choices}
            selected={selected}
            onSelect={(context) => select(context.profile?.id)}
            management={
              selected?.profile
                ? {
                    setEnabled: profileMutations({
                      organization,
                      app: selected.app.id,
                      profile: selected.profile.id,
                    }).setEnabled,
                    remove: profileMutations({
                      organization,
                      app: selected.app.id,
                      profile: selected.profile.id,
                    }).remove,
                    Failure: HostedFailure,
                    onRemoved: () => select(undefined, "accounts"),
                  }
                : undefined
            }
          />
        )
      }
      actions={
        app === undefined || access === undefined ? (
          <Skeleton className="h-9 w-28 max-[740px]:h-11" />
        ) : (
          <>
            {canUse && selected !== undefined && openApp?.(app, selected.profile)}
            {canManage && (role === "owner" || role === "admin") ? (
              <PublishApp app={app} atoms={appManagement(organization)} Failure={HostedFailure} />
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabledReason={
                  role === undefined
                    ? "Checking organization access…"
                    : role === "owner" || role === "admin"
                      ? manageReason
                      : "Only organization owners and admins can publish apps."
                }
              >
                Publish
              </Button>
            )}
          </>
        )
      }
    >
      {setupRequest && app && inventoryData && (
        <SetupDialog
          key={setupRequest}
          app={app}
          mutation={accountSelectionAtom({
            organization,
            app: app.id,
            target: { kind: "new", request: setupRequest },
          })}
          Failure={HostedFailure}
          onClose={() => setSetupRequest(undefined)}
          onSaved={(saved) => select(saved.id, "accounts")}
        />
      )}
      <QueryResult
        result={authority.result}
        Failure={HostedFailure}
        retry={authority.refresh}
        pending={pending}
      >
        {() => (
          <QueryResult
            result={query.result}
            Failure={HostedFailure}
            retry={query.refresh}
            pending={pending}
          >
            {(current) => {
              if (selectedView === "skills")
                return (
                  <AppSkills
                    canEdit={canManage}
                    app={current}
                    bindings={appBrowserBindings(organization, current)}
                    Failure={HostedFailure}
                  />
                );
              if (selectedView === "settings")
                return (
                  <AppSettings
                    app={current}
                    copyAction={
                      canManage ? (
                        <CopyApp
                          key={current.id}
                          Failure={HostedFailure}
                          app={current}
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
                      ) : (
                        <Button variant="outline" size="sm" disabledReason={manageReason}>
                          Make a copy
                        </Button>
                      )
                    }
                    renameAction={
                      canManage ? (
                        <AppRename app={current} />
                      ) : (
                        <Button variant="outline" size="sm" disabledReason={manageReason}>
                          Rename
                        </Button>
                      )
                    }
                    deleteAction={
                      canManage ? (
                        <DeleteApp app={current} />
                      ) : (
                        <Button variant="destructive" size="sm" disabledReason={manageReason}>
                          Delete app
                        </Button>
                      )
                    }
                  >
                    <section className="rounded-lg border p-5">
                      <AppAccessSettings app={current.id} />
                    </section>
                  </AppSettings>
                );
              if (
                selectedView === "source" ||
                selectedView === "history" ||
                selectedView === "deployments"
              )
                return !canManage ? (
                  <p className="p-5 text-sm text-muted-foreground">
                    The app creator and organization admins can inspect app source.
                  </p>
                ) : selectedView === "deployments" ? (
                  <AppDeployments key={current.id} app={current} />
                ) : (
                  <AppSource key={current.id} app={current} view={selectedView} />
                );
              if (!canUse)
                return (
                  <p className="p-5 text-sm text-muted-foreground">
                    This app is not shared with you. You can manage its settings.
                  </p>
                );
              return (
                <QueryResult
                  result={inventory.result}
                  Failure={HostedFailure}
                  retry={inventory.refresh}
                  pending={pending}
                >
                  {(inventory) => (
                    <QueryResult
                      result={setups.result}
                      Failure={HostedFailure}
                      retry={setups.refresh}
                      pending={pending}
                    >
                      {(entries) => {
                        const contexts = accountContexts(current, entries);
                        const previewContexts = contexts.filter(
                          (context) =>
                            accountSelectionIssues(
                              context.app,
                              context.accounts,
                              inventory.accounts,
                            ).length === 0,
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
                          accountContexts(current, entries, true),
                          profile,
                        );
                        if (selectedView === "tools")
                          return context === undefined ? (
                            empty
                          ) : (
                            <AppTools
                              key={context.key}
                              app={context.app}
                              profile={context.profile}
                              accounts={inventory.accounts}
                              selected={tool}
                            />
                          );
                        if (selectedView === "workflows" || selectedView === "webhooks")
                          return context === undefined ? (
                            empty
                          ) : (
                            <AppResources
                              key={context.key}
                              context={context}
                              view={selectedView}
                              editable={context.profile !== undefined || canManage}
                            />
                          );
                        if (selectedView === "schedules")
                          return context === undefined ? (
                            empty
                          ) : (
                            <AppSchedules
                              app={current}
                              canEdit={canManage}
                              key={context.key}
                              enabled={context.profile?.enabled !== false}
                              bindings={scheduleBindings(
                                {
                                  organization,
                                  app: current.id,
                                  profile: context.profile?.id,
                                },
                                context.profile === undefined ? canManage : context.profile.enabled,
                              )}
                              Failure={HostedFailure}
                            />
                          );
                        if (selectedView === "overview")
                          return (
                            <AppOverview
                              app={current}
                              entries={
                                <AppOverviewEntries
                                  app={current}
                                  bindings={appBrowserBindings(organization, current)}
                                  workflows={
                                    <AppWorkflowPreview
                                      empty={previewEmpty}
                                      Failure={HostedFailure}
                                      sources={previewContexts.map((context) => ({
                                        key: context.key,
                                        query: appBrowserBindings(
                                          organization,
                                          context.app,
                                          context.profile,
                                        ).workflows,
                                      }))}
                                    />
                                  }
                                  Failure={HostedFailure}
                                />
                              }
                              accounts={
                                <AppOverviewAccounts
                                  app={current}
                                  contexts={contexts}
                                  accounts={inventory.accounts}
                                />
                              }
                              tools={
                                <AppOverviewTools
                                  app={current}
                                  Failure={HostedFailure}
                                  empty={previewEmpty}
                                  sources={previewContexts.map((context) => ({
                                    key: context.key,
                                    query: toolsAtom({
                                      organization,
                                      app: current.id,
                                      profile: context.profile?.id,
                                      expectedProfileRevision: context.profile?.revision,
                                      deployment: current.activeDeployment ?? undefined,
                                      accounts: JSON.stringify(context.accounts),
                                    }),
                                  }))}
                                />
                              }
                              sourceDisabledReason={sourceReason}
                              source={
                                canManage ? (
                                  <QueryView
                                    query={appManagement(organization).authoring(current.id)}
                                    Failure={HostedFailure}
                                    pending={<OverviewCardLoading label="Loading source preview" />}
                                  >
                                    {(source) => <AppOverviewSource source={source} />}
                                  </QueryView>
                                ) : (
                                  <p className="py-5 text-sm text-muted-foreground">
                                    Source is restricted.
                                  </p>
                                )
                              }
                            />
                          );
                        return context === undefined && profile !== undefined ? (
                          empty
                        ) : (
                          <div className="max-w-3xl space-y-4 p-5 max-[740px]:p-4">
                            {/* Editors capture their target on open. A newly created profile must not reset an active draft. */}
                            <AppAccounts
                              app={current}
                              profile={context?.profile}
                              accounts={inventory.accounts}
                              redirectUri={inventory.accountSetup.redirectUri}
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
                                    organization,
                                    app: current.id,
                                    profile: context.profile.id,
                                  }).reconcile
                                }
                                Failure={HostedFailure}
                              />
                            )}
                            {setupActions}
                          </div>
                        );
                      }}
                    </QueryResult>
                  )}
                </QueryResult>
              );
            }}
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
