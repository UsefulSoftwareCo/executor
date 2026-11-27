import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { FilterIcon } from "@hugeicons/core-free-icons";
import { useHydrated } from "@executor-js/ui/hooks/hydrated";
import { OrganizationSettingsPending } from "./organization-settings-pending.tsx";
import { AddAppBack } from "./add-app.tsx";
import { Button } from "@executor-js/ui/components/button";
import { Skeleton } from "@executor-js/ui/components/skeleton";
import { SearchInput } from "@executor-js/ui/dashboard/common";
import { AppDetailPending } from "@executor-js/ui/dashboard/app-loading";
import { PageFrame, PageHeader } from "@executor-js/ui/dashboard/page";
import { parseAppSearch } from "../../contracts/navigation.ts";
import {
  appliedFilterCount,
  parseToolCallSearch,
  type ToolCallSearch,
} from "../../contracts/tool-calls.ts";
import { Link, useLocation } from "@tanstack/react-router";
import {
  ApprovalCardPending,
  ApprovalsPending,
  CatalogPageSkeleton,
  InventoryPageSkeleton,
  PageSkeleton,
  WebhookSetupFrame,
  WebhookSetupLoading,
} from "@executor-js/ui/dashboard/loading";

export const groupsTitle = "Groups";
export const groupsDescription = "Organize the people in your team.";

export function GroupsFrame({ children }: { readonly children: ReactNode }) {
  return (
    <PageFrame>
      <PageHeader title={groupsTitle} description={groupsDescription} />
      {children}
    </PageFrame>
  );
}

export function GroupsLoading() {
  return (
    <div
      role="status"
      aria-label="Loading groups"
      className="min-h-48 rounded-lg border bg-muted/30 p-5 text-sm text-muted-foreground"
    >
      Loading groups…
    </div>
  );
}

export const activityTitle = "Activity";
export const activityDescription =
  "Which tools were called, by whom, and how each call ended. Calls are kept for 30 days.";

export function ActivityFrame({ children }: { readonly children: ReactNode }) {
  return (
    <PageFrame>
      <PageHeader title={activityTitle} description={activityDescription} />
      {children}
    </PageFrame>
  );
}

export const activitySearchPlaceholder = "Search or paste a reference";

export function ActivityFilterButton({
  count,
  ...props
}: { readonly count: number } & Omit<ComponentProps<typeof Button>, "children">) {
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={count === 0 ? "Filter" : `Filter, ${count} applied`}
      {...props}
    >
      <HugeiconsIcon icon={FilterIcon} strokeWidth={2} aria-hidden />
      Filter
      {count > 0 && (
        <span
          aria-hidden
          className="rounded-full bg-foreground px-1.5 text-[11px] leading-4.5 text-background"
        >
          {count}
        </span>
      )}
    </Button>
  );
}

export function ActivityToolbarPending({ search }: { readonly search: ToolCallSearch }) {
  return (
    <div inert className="mb-2.5 flex items-center gap-2">
      <SearchInput
        value={search.q ?? ""}
        onChange={() => {}}
        placeholder={activitySearchPlaceholder}
      />
      <ActivityFilterButton count={appliedFilterCount(search)} />
    </div>
  );
}

export function ActivityListPending() {
  return (
    <>
      <div className="mb-3 flex min-h-6 items-center">
        <Skeleton className="h-3.5 w-48" />
      </div>
      <div className="min-h-64 border-t">
        <LoadingAnnouncement>Loading tool calls…</LoadingAnnouncement>
      </div>
    </>
  );
}

export function ScheduledApprovalFrame({
  organizationSlug,
  children,
}: {
  readonly organizationSlug: string;
  readonly children: ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-2xl p-4 md:p-6">
      <Link
        to="/org/$organizationSlug/approvals"
        params={{ organizationSlug }}
        className="mb-4 inline-flex text-sm text-muted-foreground"
      >
        Back to approvals
      </Link>
      {children}
    </main>
  );
}

const announceAfterMs = 100;

export function LoadingAnnouncement({ children }: { readonly children: string }) {
  const hydrated = useHydrated();
  const [said, setSaid] = useState(!hydrated);
  useEffect(() => {
    const timer = setTimeout(() => setSaid(true), announceAfterMs);
    return () => clearTimeout(timer);
  }, []);
  return (
    <p role="status" className="sr-only">
      {said ? children : ""}
    </p>
  );
}

export function UnknownPagePending({ fullScreen = false }: { readonly fullScreen?: boolean }) {
  return (
    <div className={fullScreen ? "min-h-dvh" : "min-h-64"}>
      <LoadingAnnouncement>Loading page…</LoadingAnnouncement>
    </div>
  );
}

export function PagePending({
  pathname: destination,
  organizationSettings,
}: { readonly pathname?: string; readonly organizationSettings?: ReactNode } = {}) {
  const location = useLocation();
  const pathname = destination ?? location.pathname;
  const search = location.search;
  const [root, organizationSlug, page, item, action] = pathname.split("/").filter(Boolean);
  if (root !== "org" || organizationSlug === undefined) return <UnknownPagePending fullScreen />;
  if (page === "apps" && item?.startsWith("app_") && (action === undefined || action === "setup")) {
    const selected = parseAppSearch(search);
    return (
      <AppDetailPending
        view={
          action === "setup"
            ? "accounts"
            : (selected.view ?? (selected.tool === undefined ? undefined : "tools"))
        }
        appScreen="pending"
        actions={<Skeleton className="h-9 w-28 max-[740px]:h-11" />}
        selectedTool={action === "setup" ? undefined : selected.tool}
        back={
          <Link to="/org/$organizationSlug/apps" params={{ organizationSlug }}>
            Apps
          </Link>
        }
      />
    );
  }
  if (page === "apps" && item === undefined)
    return (
      <InventoryPageSkeleton
        kind="apps"
        action={<Skeleton className="h-9 w-22 rounded-md" aria-label="Loading app actions" />}
      />
    );
  if (page === "accounts" && item === undefined) return <InventoryPageSkeleton kind="accounts" />;
  if (page === "organization")
    return <OrganizationSettingsPending>{organizationSettings}</OrganizationSettingsPending>;
  if (page === "approvals")
    return item === undefined ? (
      <ApprovalsPending />
    ) : (
      <ScheduledApprovalFrame organizationSlug={organizationSlug}>
        <ApprovalCardPending />
      </ScheduledApprovalFrame>
    );
  if (page === "groups")
    return (
      <GroupsFrame>
        <GroupsLoading />
      </GroupsFrame>
    );
  if (page === "activity")
    return (
      <ActivityFrame>
        <ActivityToolbarPending search={parseToolCallSearch(search)} />
        <ActivityListPending />
      </ActivityFrame>
    );
  if (page === "webhooks")
    return (
      <WebhookSetupFrame>
        <WebhookSetupLoading />
      </WebhookSetupFrame>
    );
  if (page === "apps" && item === "add" && action === undefined)
    return <CatalogPageSkeleton back={<AddAppBack organizationSlug={organizationSlug} />} />;
  if (page === "apps" && item === "add") return <PageSkeleton title="App catalog" />;
  if (page === "accounts") return <PageSkeleton title="Account" />;
  if (page === "apps") return <PageSkeleton title="App" />;
  if (page === "connect") return <PageSkeleton title="Connections" />;
  return <UnknownPagePending />;
}
