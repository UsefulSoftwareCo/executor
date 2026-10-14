import { OverviewCatalog } from "./overview-catalog.tsx";
import type { App, ToolSummary } from "@executor-js/sdk";
import type { AppAuthoringMetadata } from "@executor-js/app-management/contracts";
import type { RequirementAccounts } from "../../contracts/app-accounts.ts";
import type { ComponentType, ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight02Icon } from "@hugeicons/core-free-icons";
import {
  accountNeedsSignIn,
  type Query,
  type FailureProps,
  type AccountSummary,
} from "../../contracts/dashboard.ts";
import { useDashboard } from "./context.tsx";
import { AppProviderIcon } from "./common.tsx";
import { Button } from "../components/button.tsx";
import { cn } from "../lib/utils.ts";

/** The app home shows current configuration; hosts supply independent tool, account, and source reads. */
export function AppOverview({
  app,
  accounts,
  tools,
  source,
  sourceDisabledReason,
  entries,
}: {
  readonly app: App;
  readonly accounts: ReactNode;
  readonly tools: ReactNode;
  readonly source?: ReactNode;
  readonly sourceDisabledReason?: string | undefined;
  readonly entries: ReactNode;
}) {
  const { AppLink } = useDashboard();
  const undeployed = app.activeDeployment === null;
  if (undeployed)
    return (
      <div className="p-7 max-[740px]:p-4">
        <EmptyState
          title="No deployment yet"
          action={
            source ? (
              <Button asChild disabledReason={sourceDisabledReason}>
                <AppLink app={app.id} view="source">
                  Open source
                </AppLink>
              </Button>
            ) : undefined
          }
        >
          {source
            ? "Your source is saved. Open it to deploy the first version."
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
          className="flex h-60 min-w-0 flex-col overflow-hidden rounded-lg border bg-background p-5 max-[740px]:p-4"
          aria-label="App accounts"
        >
          <div className="mb-1 flex min-h-9 shrink-0 items-center justify-between gap-3 border-b pb-3">
            <h3 className="text-sm font-medium">Accounts</h3>
            {!undeployed && (
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
          className="flex h-60 min-w-0 flex-col overflow-hidden rounded-lg border bg-background p-5 max-[740px]:p-4"
          aria-label="App tools preview"
        >
          {tools}
        </section>
        {entries}
        {source && (
          <section
            className="flex h-60 min-w-0 flex-col overflow-hidden rounded-lg border bg-background p-5 max-[740px]:p-4"
            aria-label="App source"
          >
            <div className="mb-1 flex min-h-9 shrink-0 items-center justify-between gap-3 border-b pb-3">
              <h3 className="text-sm font-medium">Source</h3>
              <Button
                asChild
                variant="ghost"
                size="xs"
                className="h-auto gap-1.5 rounded-none p-0 text-xs font-normal text-muted-foreground max-[740px]:min-h-0"
                disabledReason={sourceDisabledReason}
              >
                <AppLink app={app.id} view="source">
                  View files
                  <HugeiconsIcon
                    icon={ArrowRight02Icon}
                    size={13}
                    className="size-3.25"
                    aria-hidden
                  />
                </AppLink>
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">{source}</div>
          </section>
        )}
      </div>
    </div>
  );
}

/** The overview lists each tool once; the Tools tab runs them. */
export function AppOverviewTools<E>({
  app,
  sources,
  Failure,
  empty,
  accountsNeeded = false,
}: {
  readonly app: App;
  readonly sources: readonly {
    readonly key: string;
    readonly query: Query<{ readonly items: readonly ToolSummary[] }, E>;
  }[];
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly empty: ReactNode;
  /** Every source lists tools per account and has none linked, so an empty list is expected. */
  readonly accountsNeeded?: boolean;
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
            accountsNeeded ? (
              <EmptyState size="card" heading="h3" title="No accounts linked">
                This app lists tools for each linked account.
              </EmptyState>
            ) : (
              <EmptyState size="card" heading="h3" title="No tools">
                This app does not expose any tools.
              </EmptyState>
            )
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

/**
 * Summarize each requirement's linked accounts: the app links of an app requirement, the caller's
 * links of a user requirement. Linking lives in Accounts.
 */
export function AppOverviewAccounts({
  app,
  requirements,
}: {
  readonly app: App;
  /** Each requirement with its linked accounts. */
  readonly requirements: readonly RequirementAccounts<AccountSummary>[];
}) {
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
    <div className="divide-y">
      {requirements.map(({ slot, requirement, linked: accounts }) => {
        const reconnect = accounts.some((account) => accountNeedsSignIn(account));
        const unavailable = accounts.some((account) => account.signIn?.state === "unavailable");
        const showSlot = requirements.some(
          (other) =>
            other.slot !== slot &&
            other.requirement.definition.name === requirement.definition.name,
        );
        return (
          <div key={slot} className="flex items-center gap-3 py-2.5">
            <AppProviderIcon app={app} provider={requirement.definition} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">
                {requirement.definition.name}
                {showSlot && <span className="ml-2 text-xs text-muted-foreground">{slot}</span>}
              </p>
              <p
                className={cn(
                  "mt-0.5 text-xs text-muted-foreground",
                  accounts.length === 0 &&
                    requirement.cardinality === "one" &&
                    "text-sign-in-warning",
                )}
              >
                {accounts.length === 0
                  ? requirement.cardinality === "one"
                    ? "Needs an account"
                    : "No accounts linked"
                  : `${accounts.length} linked${requirement.scope === "app" ? " for everyone" : ""}`}
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
