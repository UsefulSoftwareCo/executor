import type { App } from "@executor-js/sdk";
import type { ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  GridViewIcon,
  BookOpen01Icon,
  WorkflowSquare01Icon,
  Calendar03Icon,
  Key01Icon,
  WebhookIcon,
  SourceCodeIcon,
  ToolsIcon,
  PackageIcon,
  Settings05Icon,
} from "@hugeicons/core-free-icons";
import { DisabledTooltip } from "../components/disabled-tooltip.tsx";
import { Skeleton } from "../components/skeleton.tsx";
import type { AppLinkProps } from "../../contracts/dashboard.ts";
import type { AppView } from "../../contracts/dashboard.ts";
import { providerDisplayUrl } from "../../contracts/dashboard.ts";
import { ProviderIcon } from "./common.tsx";
import { useDashboard } from "./context.tsx";
import { productTitle, useDocumentTitle } from "../hooks/document-title.ts";
import { cn } from "../lib/utils.ts";

const sections = [
  { view: "overview", label: "Overview", icon: GridViewIcon },
  { view: "accounts", label: "Accounts", icon: Key01Icon },
  { view: "tools", label: "Tools", icon: ToolsIcon },
  { view: "skills", label: "Skills", icon: BookOpen01Icon },
  { view: "workflows", label: "Workflows", icon: WorkflowSquare01Icon },
  { view: "schedules", label: "Schedules", icon: Calendar03Icon },
  { view: "webhooks", label: "Webhooks", icon: WebhookIcon },
  { view: "source", label: "Source", icon: SourceCodeIcon },
  { view: "deployments", label: "Deployments", icon: PackageIcon },
  { view: "settings", label: "Settings", icon: Settings05Icon },
] as const;
const contentClasses = {
  skills: "min-h-0 min-w-0 flex-1 overflow-auto",
  workflows: "min-h-0 min-w-0 flex-1 overflow-auto",
  webhooks: "min-h-0 min-w-0 flex-1 overflow-auto",
  schedules: "min-h-0 min-w-0 flex-1 overflow-auto",
  settings: "min-h-0 min-w-0 flex-1 overflow-auto",
  overview: "min-h-0 min-w-0 flex-1 overflow-auto",
  tools:
    "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden [&>.app-account-setup]:m-5 [&>.accounts-section]:m-5",
  accounts: "min-h-0 min-w-0 flex-1 overflow-auto",
  source: "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
  history: "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
  deployments: "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
} as const;

/** A stable app heading and linked section tabs frame each product's app details. */
export function AppDetailLayout({
  app,
  view,
  canInspectSource,
  sourceDisabledReason,
  back,
  actions,
  setupPicker,
  children,
}: {
  readonly app: App | undefined;
  readonly view: AppView;
  readonly canInspectSource: boolean;
  readonly sourceDisabledReason?: string | undefined;
  readonly back: ReactNode;
  readonly actions?: ReactNode;
  readonly setupPicker?: ReactNode;
  readonly children: ReactNode;
}) {
  const provider = app && Object.values(app.requirements.accounts)[0]?.definition;
  useDocumentTitle(productTitle(app?.name ?? "App"));
  return (
    <div className="flex min-h-0 flex-1 flex-col [--app-tools-list-width:260px]">
      <header className="shrink-0 px-7 pb-7 pt-5 max-[740px]:px-4 max-[740px]:pb-5 max-[740px]:pt-2">
        <div className="mb-5 w-fit text-xs text-muted-foreground [&_a]:inline-flex [&_a]:min-h-7 [&_a]:items-center [&_a]:gap-2 [&_a:hover]:text-foreground max-[740px]:mb-2 max-[740px]:[&_a]:min-h-11">
          {back}
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
          <div className="flex min-w-0 flex-1 items-center gap-4">
            <ProviderIcon
              name={provider?.name ?? app?.name ?? "App"}
              url={providerDisplayUrl(provider)}
              large
            />
            <h1
              className="min-w-0 truncate text-2xl font-semibold tracking-tight max-[740px]:text-xl"
              title={app?.name}
            >
              {app ? (
                <BoundAppLink
                  app={app.id}
                  aria-label={`${app.name} overview`}
                  className="hover:underline"
                >
                  {app.name}
                </BoundAppLink>
              ) : (
                <>
                  <Skeleton className="h-7 w-40" />
                  <span className="sr-only">Loading app</span>
                </>
              )}
            </h1>
          </div>
          {(actions || setupPicker) && (
            <div className="ml-auto flex flex-wrap items-center justify-end gap-1 empty:hidden max-[640px]:w-full">
              {actions}
              {setupPicker}
            </div>
          )}
        </div>
      </header>
      <div className="shrink-0 border-b">
        <nav
          aria-label="App navigation"
          className="-mb-px flex gap-1 overflow-x-auto px-7 max-[740px]:px-4"
        >
          {sections.map((section) => {
            const classes = cn(
              "relative flex min-h-11 shrink-0 items-center gap-2 rounded-t-lg border border-transparent px-4 text-[13px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:outline-ring focus-visible:-outline-offset-4 max-[740px]:px-3",
              (view === section.view || (view === "history" && section.view === "source")) &&
                "border-border border-b-background bg-background font-medium text-foreground hover:bg-background",
            );
            const content = (
              <>
                <HugeiconsIcon icon={section.icon} size={16} strokeWidth={1.7} aria-hidden />
                {section.label}
              </>
            );
            if (!canInspectSource && (section.view === "source" || section.view === "deployments"))
              return (
                <DisabledTooltip
                  key={section.view}
                  reason={sourceDisabledReason ?? "Checking app access…"}
                >
                  <button type="button" disabled className={cn(classes, "opacity-50")}>
                    {content}
                  </button>
                </DisabledTooltip>
              );
            return app ? (
              <BoundAppLink
                key={section.view}
                app={app.id}
                view={section.view}
                className={classes}
                aria-current={
                  view === section.view || (view === "history" && section.view === "source")
                    ? "page"
                    : undefined
                }
              >
                {content}
              </BoundAppLink>
            ) : (
              <span key={section.view} className={classes}>
                {content}
              </span>
            );
          })}
        </nav>
      </div>
      <div className={contentClasses[view]}>{children}</div>
    </div>
  );
}

/** Unknown app metadata can render its frame before product navigation bindings are ready. */
function BoundAppLink(props: AppLinkProps) {
  const { AppLink } = useDashboard();
  return <AppLink {...props} />;
}
