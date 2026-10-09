import { Link, useLocation } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  BoxesIcon,
  FingerPrintIcon,
  Key01Icon,
  Plug01Icon,
  Settings05Icon,
  Shield01Icon,
  UserCircleIcon,
  UserGroupIcon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { parseAccountSearch } from "../../contracts/navigation.ts";
import type { OrganizationAccess } from "@executor-js/hosted-server/organization";
import { DashboardShell as SharedShell } from "@executor-js/ui/dashboard/shell";
import { Skeleton } from "@executor-js/ui/components/skeleton";
import { SessionMenu } from "./auth.tsx";
import { useDocumentationUrl } from "../documentation.ts";

const items = [
  { to: "/org/$organizationSlug/apps", label: "Apps", icon: BoxesIcon },
  { to: "/org/$organizationSlug/connect", label: "Connections", icon: Plug01Icon },
  { to: "/org/$organizationSlug/accounts", label: "Accounts", icon: UserCircleIcon },
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
  children,
}: {
  readonly organization?: {
    readonly slug: string;
    readonly role: OrganizationAccess["role"] | undefined;
  };
  readonly pendingPage?: string;
  /** The host's own organization pages, after the common ones. */
  readonly children?: ReactNode;
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
      {children}
    </>
  );
}

/** Personal settings belong to the signed-in user, not to the organization in the URL. */
const accountItems = [
  { to: "/account/profile", label: "Profile", icon: UserIcon },
  { to: "/account/security", label: "Security", icon: FingerPrintIcon },
  { to: "/account/tokens", label: "Tokens", icon: Key01Icon },
] as const;

/** Links for the account area; none of them take an organization. */
export function AccountNavigation() {
  const { search } = useLocation();
  const { organization } = parseAccountSearch(search);
  return (
    <>
      {accountItems.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          search={{ organization }}
          activeProps={{ className: "active", "aria-current": "page" }}
        >
          <HugeiconsIcon icon={item.icon} strokeWidth={2} size={16} aria-hidden />
          {item.label}
        </Link>
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
  banner,
  support,
  pendingPage = "apps",
  account = false,
  children,
}: {
  readonly organizationSlug?: string;
  /** The organization switcher, or the account area's way back to an organization. */
  readonly organization: ReactNode;
  readonly navigation: ReactNode;
  readonly banner?: ReactNode;
  /** Cloud offers a support dialog; self-host has no support channel of its own. */
  readonly support?: ReactNode;
  readonly pendingPage?: string;
  /** Account pages have no organization settings link; their wordmark returns to the root. */
  readonly account?: boolean;
  readonly children: ReactNode;
}) {
  const docsUrl = useDocumentationUrl();
  const brand = {
    className:
      "wordmark flex items-center gap-2 h-12 min-w-0 font-mono text-[15px] font-medium max-[740px]:h-11 max-[740px]:shrink-0",
    children: <span>executor</span>,
  };
  return (
    <SharedShell
      docsUrl={docsUrl}
      brand={
        account ? (
          <Link to="/" {...brand} />
        ) : organizationSlug === undefined ? (
          <div {...brand} />
        ) : (
          <Link to="/org/$organizationSlug/apps" params={{ organizationSlug }} {...brand} />
        )
      }
      banner={banner}
      support={support}
      navigation={
        <>
          {navigation}
          {!account && (
            <NavigationItem
              item={settings}
              organizationSlug={organizationSlug}
              pendingPage={pendingPage}
            />
          )}
        </>
      }
      footer={
        <div className="hosted-identity w-full py-0 px-[4px] [&_.session-menu]:border-t [&_.session-menu]:border-t-border">
          {organization}
          <SessionMenu organization={account ? undefined : organizationSlug} />
        </div>
      }
    >
      {children}
    </SharedShell>
  );
}
