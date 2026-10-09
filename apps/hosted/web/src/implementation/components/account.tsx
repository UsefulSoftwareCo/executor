import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link, useLocation } from "@tanstack/react-router";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@executor-js/ui/components/button";
import { lastOrganizationAtom, sessionAtom } from "../../contracts/auth.ts";
import { parseAccountSearch } from "../../contracts/navigation.ts";
import { organizationsAtom, type OrganizationSummary } from "../../contracts/organization.ts";
import {
  AccountNavigation,
  DashboardFrame,
  OrganizationSwitcherSkeleton,
} from "./dashboard-frame.tsx";
import { OrganizationAvatar } from "./organization.tsx";
import { TokensPending } from "./tokens-pending.tsx";
import { ProfilePending, SecurityPending } from "./account-pending.tsx";
export { TokensPending } from "./tokens-pending.tsx";
export {
  AccountSettingPending,
  ProfilePending,
  SecurityPending,
  SessionsPending,
  accountSettingClass,
  profileDescription,
  profileTitle,
  securityDescription,
  securityTitle,
} from "./account-pending.tsx";

/**
 * Account pages live outside every organization. The organization a visitor arrived from, named
 * in the URL or remembered from their last visit, only preselects choices and the way back.
 */
export function useAccountOrganization(reference?: string) {
  const organizations = useAtomValue(organizationsAtom);
  const session = Option.getOrUndefined(AsyncResult.value(useAtomValue(sessionAtom)));
  const saved = useAtomValue(lastOrganizationAtom);
  const memberships: ReadonlyArray<OrganizationSummary> = AsyncResult.isSuccess(organizations)
    ? organizations.value
    : [];
  const remembered =
    saved !== null && session != null && saved.user === session.user.id
      ? saved.organization
      : undefined;
  const selected =
    memberships.find((item) => item.id === reference || item.slug === reference) ??
    memberships.find((item) => item.id === remembered);
  return { organizations, memberships, selected };
}

/** The sidebar slot the organization switcher occupies in the dashboard: a way back. */
function OrganizationReturn({ reference }: { readonly reference: string | undefined }) {
  const { organizations, selected } = useAccountOrganization(reference);
  const retry = useAtomRefresh(organizationsAtom);
  if (AsyncResult.isInitial(organizations)) return <OrganizationSwitcherSkeleton />;
  const linkClass =
    "organization-trigger flex min-h-10 w-full items-center gap-2 rounded-[6px] p-[6px] text-left text-[13px] hover:bg-accent";
  return (
    <div className="organization-switcher min-w-0 pb-2 [&_.auth-error]:mt-2 [&_.auth-error]:text-[12px]">
      {selected === undefined ? (
        <Link to="/" className={linkClass} title="Organizations">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-[5px] border text-muted-foreground">
            <HugeiconsIcon icon={ArrowLeft02Icon} strokeWidth={2} size={14} aria-hidden />
          </span>
          <span className="organization-name min-w-0 flex-1 truncate font-medium">
            Organizations
          </span>
        </Link>
      ) : (
        <Link
          to="/org/$organizationSlug/apps"
          params={{ organizationSlug: selected.slug }}
          className={linkClass}
          title={`Back to ${selected.name}`}
        >
          <OrganizationAvatar name={selected.name} logo={selected.logo} />
          <span className="organization-name min-w-0 flex-1 truncate font-medium">
            Back to {selected.name}
          </span>
        </Link>
      )}
      {AsyncResult.isFailure(organizations) && (
        <div className="auth-error flex items-center justify-between gap-2 text-destructive">
          <span>Could not load organizations.</span>
          <Button variant="ghost" size="sm" onClick={retry}>
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}

/** The dashboard frame for personal settings: account navigation and no organization boundary. */
export function AccountShell({
  banner,
  support,
  children,
}: {
  readonly banner?: ReactNode;
  readonly support?: ReactNode;
  readonly children: ReactNode;
}) {
  const { search } = useLocation();
  const { organization } = parseAccountSearch(search);
  return (
    <DashboardFrame
      account
      organization={<OrganizationReturn reference={organization} />}
      navigation={<AccountNavigation />}
      banner={banner}
      support={support}
    >
      {children}
    </DashboardFrame>
  );
}

/** The same frame while the account bundle loads, with the pending page the address names. */
export function AccountPending({
  banner,
  support,
  security,
}: {
  readonly banner?: ReactNode;
  readonly support?: ReactNode;
  /** The host's sign-in sections, so the security page keeps its layout while loading. */
  readonly security?: ReactNode;
}) {
  const { pathname } = useLocation();
  const [, section] = pathname.split("/").filter(Boolean);
  return (
    <AccountShell banner={banner} support={support}>
      {section === "tokens" ? (
        <TokensPending />
      ) : section === "security" ? (
        <SecurityPending>{security}</SecurityPending>
      ) : (
        <ProfilePending />
      )}
    </AccountShell>
  );
}
