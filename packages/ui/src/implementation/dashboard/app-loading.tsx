import { SkillBrowserLoading, WorkflowBrowserLoading } from "./app-browser-loading.tsx";
import type { ReactElement, ReactNode } from "react";
import { AppDetailLayout } from "./app-detail.tsx";
/** App tabs reserve the layout of their own content at every data-loading boundary. */
import type { App } from "@executor-js/sdk";
import type { AppView } from "../../contracts/dashboard.ts";
import { Skeleton } from "../components/skeleton.tsx";
import { AppSectionHeader, AppSectionTitle } from "./app-section-header.tsx";
import { AppSchedulesLoading } from "./schedules.tsx";
import { SourceBrowserLoading } from "./source-browser.tsx";
import { ToolBrowserLoading } from "./tools.tsx";
import { EmptyState } from "./empty-state.tsx";
import { cn } from "../lib/utils.ts";

/** Card contents load independently, without replacing a card with a table skeleton. */
export function OverviewCardLoading({
  label,
  rows = 4,
  description = true,
  descriptionLines = 1,
}: {
  readonly label: string;
  readonly rows?: number;
  readonly description?: boolean;
  readonly descriptionLines?: 1 | 2;
}) {
  return (
    <div role="status" aria-label={label} className={description ? "divide-y" : "space-y-4 py-5"}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden className={description ? "py-3.5" : ""}>
          <Skeleton className="h-5 w-2/3" />
          {description && (
            <Skeleton className={descriptionLines === 2 ? "mt-1 h-10 w-full" : "mt-1 h-5 w-full"} />
          )}
        </div>
      ))}
      <span className="sr-only">{label}…</span>
    </div>
  );
}

/** Reserve the same fixed-height cards and responsive grid as the app overview. */
export function AppOverviewLoading({ app }: { readonly app?: App | undefined }) {
  return (
    <section role="status" aria-label="Loading overview" className="app-overview w-full">
      <div className={cn("grid grid-cols-1 gap-4 p-7 max-[740px]:p-4", "min-[1100px]:grid-cols-3")}>
        {["Accounts", "Tools", "Skills", "Workflows", "Source"].map((title) => (
          <section
            key={title}
            aria-label={`App ${title.toLowerCase()} placeholder`}
            className="flex h-60 min-w-0 flex-col overflow-hidden rounded-lg border bg-background p-5 max-[740px]:p-4"
          >
            <div className="mb-1 flex min-h-9 shrink-0 items-center justify-between gap-3 border-b pb-3">
              <h3 className="text-sm font-medium">{title}</h3>
              <Skeleton className="h-3 w-14" />
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {title === "Accounts" &&
              app &&
              Object.keys(app.requirements.accounts).length === 0 ? (
                <p className="py-5 text-sm text-muted-foreground">
                  {app.activeDeployment === null
                    ? "Account requirements appear after deployment."
                    : "No accounts required."}
                </p>
              ) : (
                <OverviewCardLoading
                  label={`Loading ${title.toLowerCase()} preview`}
                  rows={title === "Source" ? 2 : 4}
                  description={title !== "Source"}
                  descriptionLines={title === "Skills" || title === "Workflows" ? 2 : 1}
                />
              )}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

/** Account slots use known requirements; zero requirements do not flash invented account rows. */
export function AppAccountsLoading({
  app,
  action,
}: {
  readonly app?: App | undefined;
  readonly action?: ReactNode;
}) {
  const requirements =
    app === undefined
      ? undefined
      : Object.entries(app.requirements.accounts).map(([slot, requirement]) => ({
          slot,
          name: requirement.definition.name,
        }));
  return (
    <section role="status" aria-label="Loading accounts" className="w-full">
      <div className="max-w-3xl space-y-3 p-5 max-[740px]:p-4">
        {requirements?.length !== 0 && action && (
          <div className="mb-4 flex max-w-185 justify-end">{action}</div>
        )}
        {requirements?.length === 0 ? (
          <EmptyState size="compact" title="No accounts required">
            This app can run without a saved account.
          </EmptyState>
        ) : (
          <div className="overflow-hidden rounded-lg border">
            {(requirements ?? [{ slot: "pending", name: undefined }]).map(({ slot, name }) => (
              <div key={slot} className="flex items-center gap-3.5 border-b p-4 last:border-b-0">
                <Skeleton className="size-8.5 shrink-0 rounded-md" />
                <div className="flex-1 space-y-2">
                  {name ? (
                    <h3 className="text-sm font-medium">{name}</h3>
                  ) : (
                    <Skeleton className="h-3.5 w-28" />
                  )}
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** Settings keeps its compact header and metadata cards, including a known copied origin. */
export function AppSettingsLoading({ app }: { readonly app?: App | undefined }) {
  return (
    <section role="status" aria-label="Loading settings" className="w-full">
      <div className="max-w-3xl space-y-6 p-7 max-[740px]:p-4">
        <div className="flex items-center justify-between gap-5 rounded-lg border p-5">
          <div className="space-y-2">
            <h3 className="text-sm font-medium">App name</h3>
            {app ? (
              <p className="text-sm text-muted-foreground">{app.name}</p>
            ) : (
              <Skeleton className="h-5 w-36" />
            )}
          </div>
          <Skeleton className="h-8 max-[740px]:h-11 w-20" />
        </div>
        {app?.copiedFrom && (
          <div className="space-y-2 rounded-lg border p-5">
            <h3 className="text-sm font-medium">Copied from</h3>
            <p className="text-sm">{app.copiedFrom.name}</p>
            <Skeleton className="h-4 w-28" />
            <Skeleton className="mt-3 h-4 w-3/4" />
          </div>
        )}
        <div aria-hidden className="flex items-start justify-between gap-5 rounded-lg border p-5">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-4 w-4/5" />
          </div>
          <Skeleton className="h-8 max-[740px]:h-11 w-24" />
        </div>
      </div>
    </section>
  );
}

/** Recent history reserves commit rows rather than the generic inventory list. */
export function SourceHistoryLoading() {
  return (
    <div role="status" aria-label="Loading history">
      <div className="overflow-hidden rounded-lg border">
        <div aria-hidden className="flex items-start gap-3 p-4">
          <Skeleton className="mt-0.5 size-4.5 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1">
            <Skeleton className="h-5 w-3/5" />
            <Skeleton className="h-4 w-2/5" />
          </div>
          <Skeleton className="h-4 w-14 shrink-0" />
        </div>
      </div>
      <span className="sr-only">Loading history…</span>
    </div>
  );
}

/** Working-source reads preserve the real toolbar, shared file-column width and code viewport. */
export function AppWorkspaceLoading({ view = "source" }: { readonly view?: "source" | "history" }) {
  return (
    <section
      role="status"
      aria-label={view === "history" ? "Loading source history" : "Loading source"}
      className="source-section flex min-h-0 flex-1 flex-col [--source-sidebar-width:16rem]"
    >
      <div className="grid min-h-12 shrink-0 grid-cols-[var(--source-sidebar-width)_minmax(0,1fr)] border-b max-md:grid-cols-1">
        <AppSectionHeader className="min-h-0 justify-start gap-2 border-b-0 border-r max-md:border-r-0">
          <Skeleton className="size-4 shrink-0" />
          <span className="font-mono">main</span>
          <Skeleton className="h-3 w-[7ch] shrink-0 font-mono" />
          <AppSectionTitle className="truncate">Working source</AppSectionTitle>
        </AppSectionHeader>
        <AppSectionHeader className="min-h-0 flex-wrap border-b-0">
          <Skeleton className="h-4 w-28" />
          <div className="flex gap-2">
            <Skeleton className="h-8 max-[740px]:h-11 w-20" />
            <Skeleton className="h-8 max-[740px]:h-11 w-16" />
          </div>
        </AppSectionHeader>
      </div>
      {view === "history" ? (
        <div className="min-h-0 flex-1 overflow-auto p-7 max-[740px]:p-4">
          <div className="mb-5 flex items-center justify-between gap-4">
            <h2 className="text-lg font-semibold">History</h2>
            <Skeleton className="h-4 w-24" />
          </div>
          <SourceHistoryLoading />
        </div>
      ) : (
        <SourceBrowserLoading className="h-auto min-h-80 min-w-0 flex-1 rounded-none border-0" />
      )}
    </section>
  );
}

/** The detail read keeps deployment statistics above the retained file browser. */
export function DeploymentSourceLoading() {
  return (
    <div
      role="status"
      aria-label="Loading deployment source"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div
        aria-hidden
        className="flex shrink-0 flex-wrap gap-x-8 gap-y-3 border-b px-5 py-3 text-xs max-[740px]:px-4"
      >
        <div className="flex items-center gap-2">
          <span>Deployed</span>
          <Skeleton className="h-4 w-28" />
        </div>
        <div className="flex items-center gap-2">
          <span>Source</span>
          <Skeleton className="h-4 w-14" />
        </div>
      </div>
      <SourceBrowserLoading className="h-auto min-h-0 flex-1 rounded-none border-0" />
    </div>
  );
}

/** Deployment-list reads reserve both the version selector and retained source panes. */
export function AppDeploymentsLoading() {
  return (
    <section
      role="status"
      aria-label="Loading deployments"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)] max-[900px]:grid-cols-1 max-[900px]:grid-rows-[auto_minmax(0,1fr)]">
        <div
          aria-hidden
          className="min-h-0 overflow-hidden border-r bg-muted/15 p-2 max-[900px]:max-h-48 max-[900px]:border-r-0 max-[900px]:border-b"
        >
          <div className="space-y-1 rounded-md bg-muted px-3 py-3">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex min-h-14 shrink-0 items-center justify-between border-b px-5 py-3 max-[740px]:px-4">
            <Skeleton className="h-5 w-32" />
          </div>
          <DeploymentSourceLoading />
        </div>
      </div>
    </section>
  );
}

/** Choose the destination tab's shape for the initial app metadata read. */
export function AppDetailLoading({
  view,
  app,
  selectedTool,
  accountAction,
}: {
  readonly view: AppView;
  readonly app?: App | undefined;
  readonly selectedTool?: string | undefined;
  readonly accountAction?: ReactNode;
}): ReactElement {
  if (app?.activeDeployment === null) {
    if (view === "tools" || view === "accounts")
      return (
        <p className="p-5 text-sm text-muted-foreground">
          Deploy this app before using its tools or selecting accounts.
        </p>
      );
    if (view === "deployments")
      return (
        <p className="p-7 text-sm text-muted-foreground">
          No deployments yet. Deploy from Source when you’re ready.
        </p>
      );
  }
  switch (view) {
    case "skills":
      return <SkillBrowserLoading />;
    case "workflows":
      return <WorkflowBrowserLoading />;
    case "overview":
      return <AppOverviewLoading app={app} />;
    case "accounts":
      return <AppAccountsLoading app={app} action={accountAction} />;
    case "webhooks":
      return (
        <p className="p-5 text-sm text-muted-foreground" role="status">
          Loading webhooks…
        </p>
      );
    case "schedules":
      return <AppSchedulesLoading />;
    case "tools":
      return <ToolBrowserLoading selected={selectedTool} />;
    case "source":
    case "history":
      return <AppWorkspaceLoading view={view} />;
    case "deployments":
      return <AppDeploymentsLoading />;
    case "settings":
      return <AppSettingsLoading app={app} />;
  }
}

/** Route and inventory loading keep the same app heading, navigation and selected-tab geometry. */
export function AppDetailPending({
  view,
  back,
  selectedTool,
  accountAction,
}: {
  readonly view: AppView;
  readonly back: ReactNode;
  readonly selectedTool?: string | undefined;
  readonly accountAction?: ReactNode;
}) {
  return (
    <AppDetailLayout app={undefined} view={view} canInspectSource back={back}>
      <AppDetailLoading view={view} selectedTool={selectedTool} accountAction={accountAction} />
    </AppDetailLayout>
  );
}
