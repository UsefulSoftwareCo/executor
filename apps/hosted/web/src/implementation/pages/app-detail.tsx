import { usePreload } from "@executor-js/ui/dashboard/context";
import { AppResources } from "./app-resources.tsx";
import { AppAccounts } from "./app-accounts.tsx";
import { AppSkills } from "@executor-js/ui/dashboard/app-skills";
import {
  AppOverviewEntries,
  AppWorkflowPreview,
} from "@executor-js/ui/dashboard/app-overview-entries";
import { appBrowserBindings } from "../../contracts/app-browser.ts";
import { appLinksAtom, userLinksAtom, type AppAccountLink } from "../../contracts/app-accounts.ts";
import {
  missingRequirements,
  requirementAccounts,
  type RequirementLink,
} from "@executor-js/ui/contracts/app-accounts";
import { AppAccessSettings } from "./resource-settings.tsx";
import { appAccessAtom } from "../../contracts/resource-access.ts";
import {
  emptyManyRequirements,
  type AccountSummary,
  type AppView,
} from "@executor-js/ui/contracts/dashboard";
import { AppSchedules, AppSchedulesLoading } from "@executor-js/ui/dashboard/schedules";
import { scheduleBindings } from "../../contracts/schedules.ts";
import { sessionAtom } from "../../contracts/auth.ts";
import { AppDetailLoading, OverviewCardLoading } from "@executor-js/ui/dashboard/app-loading";
import { Exit, Option, Schema } from "effect";
import { AsyncResult } from "effect/reactivity";
import { HostedFailure, useDashboardAtoms } from "../components/dashboard-bindings.tsx";
import { dashboardAtoms } from "../../contracts/dashboard-bindings.ts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AppId, type App } from "@executor-js/sdk";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@executor-js/ui/components/button";
import { Skeleton } from "@executor-js/ui/components/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "@executor-js/ui/components/dialog";
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
import { allResults, QueryView, QueryResult, useQuery } from "@executor-js/ui/dashboard/context";
import {
  toolsAtom,
  liveAppAtom,
  acknowledgeApp,
  appError,
  removeAppAtom,
  renameAppAtom,
} from "../../contracts/apps.ts";
import { type OrganizationPageReads, useOrganizationRoute } from "../components/organization.tsx";
import { AppTools } from "./app-tools.tsx";
import { AppSource, AppVersions } from "./app-source.tsx";

/** The organization's inventory and the app, its linked accounts and its access, keyed by the URL. */
export const appDetailPageReads: OrganizationPageReads = (organization, params) =>
  Option.match(Schema.decodeUnknownOption(AppId)(params.appId), {
    onNone: () => [],
    onSome: (app) => [
      dashboardAtoms(organization).inventory,
      liveAppAtom({ organization, app }),
      appLinksAtom({ organization, app }),
      userLinksAtom({ organization, app }),
      appAccessAtom({ organization, app }),
    ],
  });

/** Views that read only the app. The others also read the inventory and the app's links. */
const appWideViews: ReadonlySet<AppView> = new Set(["settings", "versions", "source", "history"]);

/**
 * Links with their sign-in state and checks by this app. Accounts the caller can use show the
 * inventory's details, which renames keep current; others only the link's.
 */
const withSummaries = (
  links: readonly AppAccountLink[],
  summaries: readonly AccountSummary[],
): readonly RequirementLink<AccountSummary>[] =>
  links.map((link) => ({
    requirement: link.requirement,
    account: {
      ...link.account,
      ...summaries.find((summary) => summary.id === link.account.id),
      signIn: link.signIn,
      ...(link.health === undefined ? {} : { health: link.health }),
    },
  }));

/** Views that run app code use the accounts linked to the app. */
export function AppDetailPage({
  appId,
  view,
  tool,
  openApp,
}: {
  readonly appId: AppId;
  readonly view?: AppView | undefined;
  readonly tool?: string | undefined;
  readonly openApp?: (app: App) => ReactNode;
}) {
  const { organization, role, slug: organizationSlug } = useOrganizationRoute();
  const navigate = useNavigate();
  const [skillDirty, setSkillDirty] = useState(false);
  useBlocker({
    shouldBlockFn: () => skillDirty && !window.confirm("Discard your unsaved changes?"),
    enableBeforeUnload: skillDirty,
  });
  const atoms = useDashboardAtoms();
  usePreload(...appDetailPageReads(organization, { appId }));
  const inventory = useQuery(atoms.inventory);
  const query = useQuery(liveAppAtom({ organization, app: appId }));
  const app = Option.isSome(query.data)
    ? query.data.value
    : Option.isSome(inventory.data)
      ? inventory.data.value.apps.find((item) => item.id === appId)
      : undefined;
  const selectedView = view ?? (tool === undefined ? "overview" : "tools");
  const appLinks = useQuery(appLinksAtom({ organization, app: appId }));
  const userLinks = useQuery(userLinksAtom({ organization, app: appId }));
  const session = useAtomValue(sessionAtom);
  const userId = AsyncResult.isSuccess(session) ? session.value?.user.id : undefined;
  const authority = useQuery(appAccessAtom({ organization, app: appId }));
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
        : "Only the app creator and organization admins can view app source and versions.";
  const missing = (forEveryone: boolean) => (
    <div className="space-y-3 p-5 text-sm text-muted-foreground">
      <p>
        {!forEveryone
          ? "Link an account in Accounts to start using this app."
          : canManage
            ? "This app needs an account linked for everyone. Link one under App accounts in Accounts."
            : "This app needs an account linked for everyone. Ask someone who can edit this app to link one."}
      </p>
      <Button variant="outline" size="sm" asChild>
        <Link
          to="/org/$organizationSlug/apps/$appId"
          params={{ organizationSlug, appId }}
          search={{ view: "accounts" }}
        >
          Go to Accounts
        </Link>
      </Button>
    </div>
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
      actions={
        app === undefined || access === undefined ? (
          <Skeleton className="h-9 w-28 max-[740px]:h-11" />
        ) : (
          <>
            {canUse && openApp?.(app)}
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
      {appWideViews.has(selectedView) || !canUse ? (
        <QueryResult
          result={allResults({ access: authority.result, current: query.result })}
          Failure={HostedFailure}
          retry={() => {
            authority.refresh();
            query.refresh();
          }}
          pending={pending}
        >
          {({ current }) => {
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
              selectedView === "versions"
            )
              return !canManage ? (
                <p className="p-5 text-sm text-muted-foreground">
                  The app creator and organization admins can inspect app source.
                </p>
              ) : selectedView === "versions" ? (
                <AppVersions key={current.id} app={current} />
              ) : (
                <AppSource key={current.id} app={current} view={selectedView} />
              );
            return (
              <p className="p-5 text-sm text-muted-foreground">
                This app is not shared with you. You can manage its settings.
              </p>
            );
          }}
        </QueryResult>
      ) : (
        <QueryResult
          result={allResults({
            access: authority.result,
            current: query.result,
            inventory: inventory.result,
            appRows: appLinks.result,
            userRows: userLinks.result,
          })}
          Failure={HostedFailure}
          retry={() => {
            authority.refresh();
            query.refresh();
            inventory.refresh();
            appLinks.refresh();
            userLinks.refresh();
          }}
          pending={pending}
        >
          {({ current, inventory, appRows, userRows }) => {
            const linked = {
              app: withSummaries(appRows, inventory.accounts),
              user: withSummaries(userRows, inventory.accounts),
            };
            const requirements = requirementAccounts(current, linked);
            const ready = missingRequirements(requirements).length === 0;
            const version = current.activeVersion ?? undefined;
            const gate = (children: ReactNode) =>
              ready
                ? children
                : missing(
                    missingRequirements(requirements).some(
                      (entry) => entry.requirement.scope === "app",
                    ),
                  );
            if (selectedView === "skills")
              return gate(
                <AppSkills
                  canEdit={canManage}
                  app={current}
                  bindings={appBrowserBindings(organization, current)}
                  Failure={HostedFailure}
                  editing={
                    canManage
                      ? {
                          atoms: appManagement(organization),
                          onDirty: setSkillDirty,
                          onApp: (get, saved) => acknowledgeApp(get, organization, saved),
                        }
                      : undefined
                  }
                />,
              );
            if (selectedView === "tools")
              return gate(<AppTools app={current} requirements={requirements} selected={tool} />);
            if (selectedView === "workflows")
              return gate(
                <AppResources app={current} view="workflows" canReadSource={canManage} />,
              );
            if (selectedView === "webhooks") return <AppResources app={current} view="webhooks" />;
            if (selectedView === "schedules") {
              return userId === undefined ? (
                <AppSchedulesLoading />
              ) : (
                <AppSchedules
                  app={current}
                  canEdit={canManage}
                  actor={userId}
                  bindings={scheduleBindings({ organization, app: current.id }, true, canManage)}
                  Failure={HostedFailure}
                />
              );
            }
            const previewEmpty = (
              <p className="py-5 text-sm text-muted-foreground">
                Link an account in Accounts to load this preview.
              </p>
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
                          sources={
                            ready
                              ? [
                                  {
                                    key: String(version),
                                    query: appBrowserBindings(organization, current).workflows,
                                  },
                                ]
                              : []
                          }
                        />
                      }
                      Failure={HostedFailure}
                    />
                  }
                  accounts={<AppOverviewAccounts app={current} requirements={requirements} />}
                  tools={
                    <AppOverviewTools
                      app={current}
                      Failure={HostedFailure}
                      empty={previewEmpty}
                      accountsNeeded={
                        emptyManyRequirements(requirements).length === requirements.length &&
                        requirements.length > 0
                      }
                      sources={
                        ready
                          ? [
                              {
                                key: String(version),
                                query: toolsAtom({ organization, app: current.id, version }),
                              },
                            ]
                          : []
                      }
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
                      <p className="py-5 text-sm text-muted-foreground">Source is restricted.</p>
                    )
                  }
                />
              );
            return (
              <div className="max-w-3xl space-y-4 p-5 max-[740px]:p-4">
                <AppAccounts
                  app={current}
                  appLinks={linked.app}
                  userLinks={linked.user}
                  canManage={canManage}
                  accounts={inventory.accounts}
                  redirectUri={inventory.accountSetup.redirectUri}
                />
              </div>
            );
          }}
        </QueryResult>
      )}
    </AppDetailLayout>
  );
}

function DeleteApp({ app }: { readonly app: App }) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const remove = useAtomSet(removeAppAtom({ organization, app: app.id }), { mode: "promiseExit" });
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        setError(undefined);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="destructive" size="sm">
          Delete app
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[440px]">
        <DialogTitle>Delete app?</DialogTitle>
        <p className="text-sm font-medium">{app.name}</p>
        <DialogDescription>
          This permanently removes the app and its saved data. Connected accounts and copies
          installed by others are kept.
        </DialogDescription>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={pending}
            onClick={async () => {
              setPending(true);
              setError(undefined);
              const result = await remove();
              setPending(false);
              if (Exit.isFailure(result)) setError(appError(result.cause));
              else {
                await navigate({ to: "/org/$organizationSlug/apps", params: { organizationSlug } });
              }
            }}
          >
            Delete app
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The mutation acknowledges shared metadata before the dialog closes. */
function AppRename({ app }: { readonly app: App }) {
  const { organization } = useOrganizationRoute();
  const rename = useAtomSet(renameAppAtom({ organization, app: app.id }), { mode: "promiseExit" });
  return <RenameApp<HostedError> app={app} Failure={HostedFailure} rename={rename} />;
}
