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
import { AppIcon } from "./common.tsx";
import { useDashboard } from "./context.tsx";
import { productTitle, useDocumentTitle } from "../hooks/document-title.ts";
import { cn } from "../lib/utils.ts";

const sections = [
  { view: "app", label: "App" },
  { view: "overview", label: "Overview" },
  { view: "accounts", label: "Accounts" },
  { view: "tools", label: "Tools" },
  { view: "skills", label: "Skills" },
  { view: "workflows", label: "Workflows" },
  { view: "schedules", label: "Schedules" },
  { view: "webhooks", label: "Webhooks" },
  { view: "source", label: "Source" },
  { view: "versions", label: "Versions" },
  { view: "settings", label: "Settings" },
] as const;
/**
 * Read at render. Server bundles can split icons into a chunk that imports this one back, so a
 * module-level table could capture them before that chunk initializes.
 */
const sectionIcon = (view: (typeof sections)[number]["view"]) => {
  switch (view) {
    case "app":
      return GridViewIcon;
    case "overview":
      return GridViewIcon;
    case "accounts":
      return Key01Icon;
    case "tools":
      return ToolsIcon;
    case "skills":
      return BookOpen01Icon;
    case "workflows":
      return WorkflowSquare01Icon;
    case "schedules":
      return Calendar03Icon;
    case "webhooks":
      return WebhookIcon;
    case "source":
      return SourceCodeIcon;
    case "versions":
      return PackageIcon;
    case "settings":
      return Settings05Icon;
  }
};
const contentClasses = {
  app: "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
  skills: "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
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
  versions: "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
} as const;

/**
 * Whether the App tab exists. `pending` holds its place while a direct link waits for the app and
 * its access, so the tab neither pops in nor shows a screen nobody has authorized yet.
 */
export type AppScreenTab = "present" | "pending" | "absent";

/**
 * The App tab exists for an app whose active version has a screen, for a caller who may use it.
 * An app known to have no screen has none at once. Otherwise the tab holds its place until the
 * app and that access are known; a failed read leaves it out.
 */
export const appScreenTab = (
  app: { readonly activeVersion: string | null; readonly hasUi?: boolean | undefined } | undefined,
  access: { readonly canUse: boolean } | undefined,
  failed: { readonly app?: boolean; readonly access?: boolean } = {},
): AppScreenTab =>
  app === undefined
    ? failed.app
      ? "absent"
      : "pending"
    : app.activeVersion === null || app.hasUi === false
      ? "absent"
      : access === undefined
        ? failed.access
          ? "absent"
          : "pending"
        : access.canUse
          ? "present"
          : "absent";

/** A stable app heading and linked section tabs frame each product's app details. */
export function AppDetailLayout({
  app,
  view,
  canInspectSource,
  appScreen = "absent",
  sourceDisabledReason,
  back,
  actions,
  children,
}: {
  readonly app: App | undefined;
  /** Undefined while the default destination waits on the App tab's answer: no tab is selected. */
  readonly view: AppView | undefined;
  readonly canInspectSource: boolean;
  readonly appScreen?: AppScreenTab;
  readonly sourceDisabledReason?: string | undefined;
  readonly back: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  useDocumentTitle(productTitle(app?.name ?? "App"));
  return (
    <div className="flex min-h-0 flex-1 flex-col [--app-tools-list-width:260px]">
      <header className="shrink-0 px-7 pb-7 pt-5 max-[740px]:flex max-[740px]:items-center max-[740px]:py-1.5 max-[740px]:pl-1 max-[740px]:pr-4">
        <div className="mb-5 w-fit shrink-0 self-start text-xs text-muted-foreground [&_a]:inline-flex [&_a]:min-h-7 [&_a]:items-center [&_a]:gap-2 [&_a:hover]:text-foreground max-[740px]:mb-0 max-[740px]:[&_a]:size-11 max-[740px]:[&_a]:justify-center max-[740px]:[&_a]:text-[0px] max-[740px]:[&_svg]:size-5">
          {back}
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4 max-[740px]:min-w-0 max-[740px]:flex-1 max-[740px]:gap-y-2 max-[740px]:py-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-4 max-[740px]:gap-2.5 max-[740px]:[&_.provider-icon-large]:size-8 max-[740px]:[&_.provider-icon-large]:rounded-[7px]">
            <AppIcon app={app} large />
            <h1
              className="min-w-0 truncate text-2xl font-semibold tracking-tight max-[740px]:text-lg"
              title={app?.name}
            >
              {app ? (
                <BoundAppLink
                  app={app.id}
                  view="overview"
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
          {(actions || (app === undefined && canInspectSource)) && (
            <div
              className={cn(
                "ml-auto flex min-h-9 flex-wrap items-center justify-end gap-1 empty:hidden max-[740px]:min-h-11 max-[640px]:ml-0 max-[640px]:w-full max-[640px]:justify-start max-[640px]:gap-2",
                // Hosts with known actions supply their placeholder before metadata arrives.
                // Do not invent an actions row for products that have none.
                app === undefined && !actions && "max-[640px]:hidden",
              )}
            >
              {app === undefined && canInspectSource && !actions ? (
                <Skeleton className="h-9 w-28 max-[740px]:h-11" />
              ) : (
                actions
              )}
            </div>
          )}
        </div>
      </header>
      <div className="shrink-0 border-b">
        <nav
          aria-label="App navigation"
          className="-mb-px flex gap-1 overflow-x-auto px-7 max-[740px]:px-4"
        >
          {sections
            .filter((section) => section.view !== "app" || appScreen !== "absent")
            .map((section) => {
              const classes = cn(
                "relative flex min-h-11 shrink-0 items-center gap-2 rounded-t-lg border border-transparent px-4 text-[13px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:outline-ring focus-visible:-outline-offset-4 max-[740px]:px-3",
                (view === section.view || (view === "history" && section.view === "source")) &&
                  "border-border border-b-background bg-background font-medium text-foreground hover:bg-background",
              );
              const content = (
                <>
                  <HugeiconsIcon
                    icon={sectionIcon(section.view)}
                    size={16}
                    strokeWidth={1.7}
                    aria-hidden
                    className="max-[740px]:hidden"
                  />
                  {section.label}
                </>
              );
              if (section.view === "app" && appScreen === "pending")
                return (
                  <span
                    key={section.view}
                    role="status"
                    aria-label="Checking for an app screen"
                    className={classes}
                  >
                    <Skeleton className="h-4 w-12" />
                  </span>
                );
              if (!canInspectSource && (section.view === "source" || section.view === "versions"))
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
              const current =
                view === section.view || (view === "history" && section.view === "source")
                  ? "page"
                  : undefined;
              return app ? (
                <BoundAppLink
                  key={section.view}
                  app={app.id}
                  view={section.view}
                  className={classes}
                  aria-current={current}
                >
                  {content}
                </BoundAppLink>
              ) : (
                <span key={section.view} className={classes} aria-current={current}>
                  {content}
                </span>
              );
            })}
        </nav>
      </div>
      <div className={contentClasses[view ?? "app"]}>{children}</div>
    </div>
  );
}

/** Unknown app metadata can render its frame before product navigation bindings are ready. */
function BoundAppLink(props: AppLinkProps) {
  const { AppLink } = useDashboard();
  return <AppLink {...props} />;
}
