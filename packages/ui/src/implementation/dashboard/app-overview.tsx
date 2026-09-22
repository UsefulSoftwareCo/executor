import { OverviewCatalog } from "./overview-catalog.tsx";
import type { AccountContext } from "./account-group.tsx";
import type { App, ToolPage } from "@executor-js/sdk";
import type { AppAuthoringMetadata } from "@executor-js/app-management/contracts";
import type { ComponentType, ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight02Icon } from "@hugeicons/core-free-icons";
import {
  accountNeedsSignIn,
  accountSelectionIssues,
  providerDisplayUrl,
  type Query,
  type FailureProps,
  type AccountSummary,
} from "../../contracts/dashboard.ts";
import { useDashboard } from "./context.tsx";
import { ProviderIcon } from "./common.tsx";
import { Button } from "../components/button.tsx";
import { cn } from "../lib/utils.ts";

/** The app home shows current configuration; hosts supply independent tool, account, and source reads. */
export function AppOverview({
  app,
  accounts,
  tools,
  source,
  entries,
}: {
  readonly app: App;
  readonly accounts: ReactNode;
  readonly tools: ReactNode;
  readonly source?: ReactNode;
  readonly entries: ReactNode;
}) {
  const { AppLink } = useDashboard();
  const draft = app.activeDeployment === null;
  if (draft)
    return (
      <div className="p-7 max-[740px]:p-4">
        <EmptyState
          title="No deployment yet"
          action={
            source ? (
              <Button asChild>
                <AppLink app={app.id} view="source">
                  Open source
                </AppLink>
              </Button>
            ) : undefined
          }
        >
          {source
            ? "Your draft is saved. Open its source to deploy the first version."
            : "The app owner needs to deploy this app before it can be used."}
        </EmptyState>
        {source && (
          <section aria-label="App source" className="mt-4 max-w-2xl rounded-lg border p-5">
            <h3 className="mb-3 text-sm font-medium">Source</h3>
            {source}
          </section>
        )}
      </div>
    );
  return (
    <div className="app-overview w-full">
      <div
        className={cn(
          "grid grid-cols-1 items-start gap-4 p-7 max-[740px]:p-4",
          source ? "min-[1100px]:grid-cols-3" : "min-[900px]:grid-cols-2",
        )}
      >
        <section
          className="flex h-60 min-w-0 flex-col overflow-hidden rounded-lg border bg-background p-5"
          aria-label="App accounts"
        >
          <div className="mb-1 flex min-h-9 shrink-0 items-center justify-between gap-3 border-b pb-3">
            <h3 className="text-sm font-medium">Accounts</h3>
            {!draft && (
              <AppLink
                app={app.id}
                view="accounts"
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                Manage
                <HugeiconsIcon icon={ArrowRight02Icon} size={13} aria-hidden />
              </AppLink>
            )}
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">{accounts}</div>
        </section>
        <section
          className="flex h-60 min-w-0 flex-col overflow-hidden rounded-lg border bg-background p-5"
          aria-label="App tools preview"
        >
          {tools}
        </section>
        {entries}
        {source && (
          <section
            className="flex h-60 min-w-0 flex-col overflow-hidden rounded-lg border bg-background p-5"
            aria-label="App source"
          >
            <div className="mb-1 flex min-h-9 shrink-0 items-center justify-between gap-3 border-b pb-3">
              <h3 className="text-sm font-medium">Source</h3>
              <AppLink
                app={app.id}
                view="source"
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                View files
                <HugeiconsIcon icon={ArrowRight02Icon} size={13} aria-hidden />
              </AppLink>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">{source}</div>
          </section>
        )}
      </div>
    </div>
  );
}

/** The overview lists each tool once; account selection belongs to the Tools tab. */
export function AppOverviewTools<E>({
  app,
  sources,
  Failure,
  empty,
}: {
  readonly app: App;
  readonly sources: readonly {
    readonly key: string;
    readonly query: Query<Pick<ToolPage, "items" | "next">, E>;
  }[];
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly empty: ReactNode;
}) {
  const { AppLink } = useDashboard();
  return (
    <ToolsPreviewFrame app={app}>
      {app.activeDeployment === null ? (
        <EmptyState size="card" heading="h3" title="No deployment yet">
          Deploy source to make tools available.
        </EmptyState>
      ) : sources.length === 0 ? (
        empty
      ) : (
        <OverviewCatalog
          sources={sources}
          items={(page) => page.items}
          Failure={Failure}
          label="Loading tools preview"
          empty={
            <EmptyState size="card" heading="h3" title="No tools">
              This app does not expose any tools.
            </EmptyState>
          }
        >
          {(tools) => (
            <div className="grid">
              {tools.slice(0, 4).map((tool) => (
                <AppLink
                  key={tool.name}
                  app={app.id}
                  view="tools"
                  className="group flex min-w-0 items-center gap-3 border-b py-3.5 last:border-b-0 hover:bg-muted/20 focus-visible:outline-ring"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs font-medium" title={tool.name}>
                      {tool.name}
                    </p>
                    {tool.description && (
                      <p className="mt-1 truncate text-xs leading-5 text-muted-foreground">
                        {tool.description}
                      </p>
                    )}
                  </div>
                  <HugeiconsIcon
                    icon={ArrowRight02Icon}
                    size={14}
                    className="shrink-0 text-muted-foreground/50 group-hover:text-foreground"
                    aria-hidden
                  />
                </AppLink>
              ))}
            </div>
          )}
        </OverviewCatalog>
      )}
    </ToolsPreviewFrame>
  );
}

function ToolsPreviewFrame({ app, children }: { readonly app: App; readonly children: ReactNode }) {
  const { AppLink } = useDashboard();
  return (
    <>
      <div className="flex min-h-9 shrink-0 items-center justify-between gap-3 border-b pb-3">
        <h3 className="text-sm font-medium">Tools</h3>
        {app.activeDeployment !== null && (
          <AppLink
            app={app.id}
            view="tools"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            View all
            <HugeiconsIcon icon={ArrowRight02Icon} size={13} aria-hidden />
          </AppLink>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
    </>
  );
}

/** Summarize providers across profiles; individual account choices live in Accounts. */
export function AppOverviewAccounts({
  app,
  accounts,
  contexts,
}: {
  readonly app: App;
  readonly accounts: readonly AccountSummary[];
  readonly contexts: readonly AccountContext[];
}) {
  const requirements = Object.entries(app.requirements.accounts);
  const selections = contexts.length === 0 ? [app] : contexts.map((context) => context.app);
  const incomplete = contexts.filter(
    (context) => accountSelectionIssues(context.app, accounts).length > 0,
  ).length;
  if (requirements.length === 0)
    return (
      <EmptyState
        size="card"
        heading="h3"
        title={app.activeDeployment === null ? "No deployment yet" : "No accounts required"}
      >
        {app.activeDeployment === null
          ? "Account requirements appear after deployment."
          : "This app can run without a saved account."}
      </EmptyState>
    );
  return (
    <div>
      <div className="divide-y">
        {requirements.map(([slot, requirement]) => {
          const ids = new Set(
            [app, ...selections].flatMap((configured) => {
              const selection = configured.accounts[slot];
              return selection === undefined
                ? []
                : typeof selection === "string"
                  ? [selection]
                  : selection;
            }),
          );
          const selected = accounts.filter((account) => ids.has(account.id));
          const reconnect = selected.some((account) => accountNeedsSignIn(account));
          const unavailable = selected.some((account) => account.signIn?.state === "unavailable");
          const showSlot = requirements.some(
            ([otherSlot, other]) =>
              otherSlot !== slot && other.definition.name === requirement.definition.name,
          );
          return (
            <div key={slot} className="flex items-center gap-3 py-2.5">
              <ProviderIcon
                name={requirement.definition.name}
                url={providerDisplayUrl(requirement.definition)}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">
                  {requirement.definition.name}
                  {showSlot && <span className="ml-2 text-xs text-muted-foreground">{slot}</span>}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {ids.size === 0
                    ? "No accounts selected"
                    : `${ids.size} ${ids.size === 1 ? "account" : "accounts"}`}
                </p>
              </div>
              {(reconnect || unavailable) && (
                <span className="text-xs text-sign-in-warning">
                  {reconnect ? "Needs sign-in" : "Unavailable"}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {incomplete > 0 && (
        <p className="border-t pt-2 text-xs text-sign-in-warning">
          {incomplete === 1 ? "1 profile needs accounts" : `${incomplete} profiles need accounts`}
        </p>
      )}
    </div>
  );
}

/** Keep source approachable on the overview; repository details belong on the Source page. */
export function AppOverviewSource({
  source,
}: {
  readonly source: typeof AppAuthoringMetadata.Type;
}) {
  return (
    <div className="space-y-3 pt-4 text-sm leading-6 text-muted-foreground">
      <p>View the files that make this app work.</p>
      <p>
        {source.canEdit
          ? "Ask your agent to help make changes."
          : "This app is maintained by Executor."}
      </p>
    </div>
  );
}
import { EmptyState } from "./empty-state.tsx";
