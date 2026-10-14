import { useEffect, useState, type ReactNode } from "react";
import { useHydrated } from "@executor-js/ui/hooks/hydrated";
import { OrganizationSettingsPending } from "./organization-settings-pending.tsx";
import { Skeleton } from "@executor-js/ui/components/skeleton";
import { AppDetailPending } from "@executor-js/ui/dashboard/app-loading";
import { PageFrame, PageHeader } from "@executor-js/ui/dashboard/page";
import { parseAppSearch } from "../../contracts/navigation.ts";
import { Link, useLocation } from "@tanstack/react-router";
import {
  ApprovalCardPending,
  ApprovalsPending,
  InventoryPageSkeleton,
  PageSkeleton,
  WebhookSetupFrame,
  WebhookSetupLoading,
} from "@executor-js/ui/dashboard/loading";

export const groupsTitle = "Groups";
export const groupsDescription = "Organize the people in your team.";

/** The groups directory and a group's members both load inside the same frame. */
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

/** A scheduled run's review: the way back to the list above the request's card. */
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

/** Long enough for the empty status to reach the accessibility tree before it speaks. */
const announceAfterMs = 100;

/**
 * Tells a screen reader that something is loading. A live region announces what changes in it,
 * not what it held when it appeared, so a status the browser adds starts empty and says its text
 * a moment later, in a separate update. A status in the server's document says it from the start:
 * it is read with the page, and the browser hydrating that document renders the same text. It is
 * never busy itself: assistive technology may hold back what a busy region says until it is no
 * longer busy.
 */
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

/**
 * A page nothing is known about yet: blank, so it guesses no page, but announced as loading so a
 * screen reader is not left with an empty region. Outside an organization it fills the screen.
 */
export function UnknownPagePending({ fullScreen = false }: { readonly fullScreen?: boolean }) {
  return (
    <div className={fullScreen ? "min-h-dvh" : "min-h-64"}>
      <LoadingAnnouncement>Loading page…</LoadingAnnouncement>
    </div>
  );
}

/**
 * Lazy pages load inside the existing organization layout with the destination's content shape.
 * Each shape is the page's own loading state, so the page replaces it without moving. Nothing is
 * known about a page this does not name, so it stays blank instead of guessing; outside an
 * organization that is the whole screen.
 */
export function PagePending({
  pathname: destination,
  organizationSettings,
}: { readonly pathname?: string; readonly organizationSettings?: ReactNode } = {}) {
  const location = useLocation();
  const pathname = destination ?? location.pathname;
  const search = location.search;
  const [root, organizationSlug, page, item, action] = pathname.split("/").filter(Boolean);
  if (root !== "org" || organizationSlug === undefined) return <UnknownPagePending fullScreen />;
  // Older setup links open the app's Accounts view. Sign-in can still return to one, so this
  // shape shows until the server redirects it there.
  if (page === "apps" && item?.startsWith("app_") && (action === undefined || action === "setup")) {
    const selected = parseAppSearch(search);
    return (
      <AppDetailPending
        view={
          action === "setup"
            ? "accounts"
            : (selected.view ?? (selected.tool === undefined ? "overview" : "tools"))
        }
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
  if (page === "webhooks")
    return (
      <WebhookSetupFrame>
        <WebhookSetupLoading />
      </WebhookSetupFrame>
    );
  if (page === "apps" && item === "add") return <PageSkeleton title="Add app" />;
  if (page === "accounts") return <PageSkeleton title="Account" />;
  if (page === "apps") return <PageSkeleton title="App" />;
  if (page === "connect") return <PageSkeleton title="Connections" />;
  // A connection link opens a dialog over an empty page.
  return <UnknownPagePending />;
}
