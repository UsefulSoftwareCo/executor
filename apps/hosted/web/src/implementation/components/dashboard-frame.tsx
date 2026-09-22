import { Link } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  BoxesIcon,
  Key01Icon,
  Plug01Icon,
  Settings05Icon,
  Shield01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import type { OrganizationAccess } from "@executor-js/hosted-server/organization";
import { DashboardShell as SharedShell } from "@executor-js/ui/dashboard/shell";
import { Skeleton } from "@executor-js/ui/components/skeleton";
import { SessionMenu } from "./auth.tsx";

const items = [
  { to: "/org/$organizationSlug/connect", label: "Connect", icon: Plug01Icon },
  { to: "/org/$organizationSlug/apps", label: "Apps", icon: BoxesIcon },
  { to: "/org/$organizationSlug/accounts", label: "Accounts", icon: Key01Icon },
  { to: "/org/$organizationSlug/api-keys", label: "API keys", icon: Key01Icon },
  { to: "/org/$organizationSlug/approvals", label: "Approvals", icon: Shield01Icon },
  { to: "/org/$organizationSlug/groups", label: "Groups", icon: UserGroupIcon },
] as const;
const settings = {
  to: "/org/$organizationSlug/organization",
  label: "Settings",
  icon: Settings05Icon,
} as const;

function NavigationItem({
  item,
  organizationSlug,
  pendingPage,
}: {
  readonly item: (typeof items)[number] | typeof settings;
  readonly organizationSlug: string | undefined;
  readonly pendingPage: string;
}) {
  const content = (
    <>
      <HugeiconsIcon icon={item.icon} strokeWidth={2} size={16} aria-hidden />
      {item.label}
    </>
  );
  if (organizationSlug === undefined)
    return (
      <a
        role="link"
        aria-disabled="true"
        tabIndex={-1}
        aria-current={item.to.endsWith(`/${pendingPage}`) ? "page" : undefined}
        className={
          item.to.endsWith(`/${pendingPage}`) ? "active pointer-events-none" : "pointer-events-none"
        }
      >
        {content}
      </a>
    );
  return (
    <Link
      to={item.to}
      params={{ organizationSlug }}
      activeProps={{ className: "active", "aria-current": "page" }}
    >
      {content}
    </Link>
  );
}

/** The same navigation labels and icons, disabled until an organization target is known. */
export function DashboardNavigation({
  organization,
  pendingPage = "apps",
}: {
  readonly organization?: {
    readonly slug: string;
    readonly role: OrganizationAccess["role"] | undefined;
  };
  readonly pendingPage?: string;
}) {
  return (
    <>
      {items.map((item) => (
        <NavigationItem
          key={item.to}
          item={item}
          organizationSlug={organization?.slug}
          pendingPage={pendingPage}
        />
      ))}
    </>
  );
}

/** Shared organization-picker geometry before its name and choices are available. */
export function OrganizationSwitcherSkeleton() {
  return (
    <div className="organization-switcher min-w-0 pb-2">
      <div className="flex min-h-10 items-center gap-2 p-1.5" aria-label="Loading organization">
        <Skeleton className="size-6 rounded-[5px]" />
        <Skeleton className="h-3 w-28" />
      </div>
    </div>
  );
}

/** Hosted layout slots shared by the resolved dashboard and authenticated entry. */
export function DashboardFrame({
  organizationSlug,
  organization,
  navigation,
  pendingPage = "apps",
  children,
}: {
  readonly organizationSlug?: string;
  readonly organization: ReactNode;
  readonly navigation: ReactNode;
  readonly pendingPage?: string;
  readonly children: ReactNode;
}) {
  const brand = {
    className:
      "wordmark flex items-center gap-2 h-12 min-w-0 font-mono text-[15px] font-medium max-[740px]:h-11 max-[740px]:shrink-0",
    children: <span>executor</span>,
  };
  return (
    <SharedShell
      brand={
        organizationSlug === undefined ? (
          <div {...brand} />
        ) : (
          <Link to="/org/$organizationSlug/apps" params={{ organizationSlug }} {...brand} />
        )
      }
      identity={organization}
      navigation={
        <>
          {navigation}
          <NavigationItem
            item={settings}
            organizationSlug={organizationSlug}
            pendingPage={pendingPage}
          />
        </>
      }
      footer={
        <div className="hosted-identity w-full py-0 px-[4px] [&_.session-menu]:border-t [&_.session-menu]:border-t-border">
          {organization}
          <SessionMenu />
        </div>
      }
    >
      {children}
    </SharedShell>
  );
}
