import { ToolAccounts } from "./tool-accounts.tsx";
import { OverviewCardLoading } from "./app-loading.tsx";
import type { App, AccountRequirement, ToolPage } from "@executor-js/sdk";
import type { AppSourceView } from "@executor-js/app-management/contracts";
import type { ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight02Icon } from "@hugeicons/core-free-icons";
import {
  accountNeedsSignIn,
  accountSelectionIssues,
  providerDisplayUrl,
  appToolReadiness,
  type QueryProps,
  type AccountSummary,
} from "../../contracts/dashboard.ts";
import { Option } from "effect";
import { useDashboard, useQuery, QueryResult } from "./context.tsx";
import { ProviderIcon } from "./common.tsx";
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
  return (
    <div className="app-overview w-full">
      <div
        className={cn(
          "grid grid-cols-1 gap-4 p-7 max-[740px]:p-4",
          source ? "min-[1100px]:grid-cols-3" : "min-[900px]:grid-cols-2",
        )}
      >
        <section
          className="flex h-80 min-w-0 flex-col overflow-hidden rounded-lg border bg-background p-5"
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
          <div className="min-h-0 flex-1 overflow-auto">{accounts}</div>
        </section>
        <section
          className="flex h-80 min-w-0 flex-col overflow-hidden rounded-lg border bg-background p-5"
          aria-label="App tools preview"
        >
          {tools}
        </section>
        {entries}
        {source && (
          <section
            className="flex h-80 min-w-0 flex-col overflow-hidden rounded-lg border bg-background p-5"
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

/** Load a small preview through the existing live catalog only when the app can be inspected. */
export function AppOverviewTools<E>({
  app,
  accounts,
  ...query
}: QueryProps<Pick<ToolPage, "items" | "next">, E> & {
  readonly app: App;
  readonly accounts: readonly AccountSummary[];
}) {
  const readiness = appToolReadiness(app, accounts);
  if (readiness.state !== "ready")
    return (
      <ToolsPreviewFrame app={app} accounts={accounts}>
        <p className="py-5 text-sm text-muted-foreground">
          {readiness.state === "not-deployed"
            ? "Deploy source to make tools available."
            : readiness.state === "unavailable"
              ? "Account status is unavailable. Check Accounts and try again."
              : "Review the app’s accounts to load its tools."}
        </p>
      </ToolsPreviewFrame>
    );

  return <LiveToolsPreview app={app} accounts={accounts} {...query} />;
}

function LiveToolsPreview<E>({
  app,
  accounts,
  query,
  Failure,
}: QueryProps<Pick<ToolPage, "items" | "next">, E> & {
  readonly app: App;
  readonly accounts: readonly AccountSummary[];
}) {
  const { AppLink } = useDashboard();
  const { result, data, refresh } = useQuery(query);
  const count = Option.isSome(data)
    ? `${data.value.items.length}${data.value.next === undefined ? "" : "+"}`
    : undefined;
  return (
    <ToolsPreviewFrame app={app} accounts={accounts} count={count}>
      <QueryResult
        result={result}
        retry={refresh}
        Failure={Failure}
        pending={<OverviewCardLoading label="Loading tools preview" />}
      >
        {(page) =>
          page.items.length === 0 ? (
            <p className="py-5 text-sm text-muted-foreground">
              This app does not expose any tools.
            </p>
          ) : (
            <div className="grid">
              {page.items.slice(0, 4).map((tool) => (
                <AppLink
                  key={tool.name}
                  app={app.id}
                  view="tools"
                  tool={tool.name}
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
          )
        }
      </QueryResult>
    </ToolsPreviewFrame>
  );
}

function ToolsPreviewFrame({
  app,
  accounts,
  count,
  children,
}: {
  readonly app: App;
  readonly count?: string | undefined;
  readonly accounts: readonly AccountSummary[];
  readonly children: ReactNode;
}) {
  const { AppLink } = useDashboard();
  return (
    <>
      <div className="flex min-h-9 shrink-0 items-center justify-between gap-3 border-b pb-3">
        <h3 className="text-sm font-medium">
          Tools
          {count !== undefined && (
            <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
              {count}
            </span>
          )}
        </h3>
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
      <div className="min-h-0 flex-1 overflow-auto">
        <ToolAccounts app={app} accounts={accounts} compact />
        {children}
      </div>
    </>
  );
}

/** Show declared account slots and real selections without implying upstream service health. */
export function AppOverviewAccounts({
  app,
  accounts,
  accountActions,
}: {
  readonly app: App;
  readonly accounts: readonly AccountSummary[];
  readonly accountActions?: (slot: string, requirement: AccountRequirement) => ReactNode;
}) {
  const { AccountLink } = useDashboard();
  const requirements = Object.entries(app.requirements.accounts);
  const issues = accountSelectionIssues(app, accounts);
  if (requirements.length === 0)
    return (
      <p className="py-5 text-sm text-muted-foreground">
        {app.activeDeployment === null
          ? "Account requirements appear after deployment."
          : "No accounts required."}
      </p>
    );
  return (
    <div className="divide-y">
      {requirements.map(([slot, requirement]) => {
        const selection = app.accounts[slot];
        const ids =
          selection === undefined ? [] : typeof selection === "string" ? [selection] : selection;
        return (
          <div key={slot} className="flex items-start gap-3 py-4">
            <ProviderIcon
              name={requirement.definition.name}
              url={providerDisplayUrl(requirement.definition)}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="text-[13px] font-medium">{requirement.definition.name}</p>
                {issues.some((issue) => issue.slot === slot) &&
                  (accountActions ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {accountActions(slot, requirement)}
                    </div>
                  ) : (
                    <span className="text-[11px] text-sign-in-warning">Needs attention</span>
                  ))}
              </div>
              {requirements.length > 1 && (
                <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{slot}</p>
              )}
              <div className="mt-1 space-y-1 text-xs leading-5 text-muted-foreground">
                {ids.length === 0 ? (
                  <p>No accounts selected</p>
                ) : (
                  ids.map((id) => {
                    const account = accounts.find((item) => item.id === id);
                    return (
                      <div
                        key={id}
                        className="flex flex-wrap items-baseline justify-between gap-x-3"
                      >
                        <span className="break-words [&_a:hover]:text-foreground [&_a:hover]:underline">
                          {account ? (
                            <AccountLink account={id}>
                              {account.label || "Unnamed account"}
                            </AccountLink>
                          ) : (
                            "Account disconnected"
                          )}
                        </span>
                        {account &&
                          (accountNeedsSignIn(account) ? (
                            <span className="text-sign-in-warning">Needs sign-in</span>
                          ) : account.signIn?.state === "unavailable" ? (
                            <span className="text-sign-in-warning">Unavailable</span>
                          ) : null)}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Keep source approachable on the overview; repository details belong on the Source page. */
export function AppOverviewSource({ source }: { readonly source: typeof AppSourceView.Type }) {
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
