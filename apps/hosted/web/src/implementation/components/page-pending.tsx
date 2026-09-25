import type { ReactNode } from "react";
import { ApiKeysPending } from "./api-keys-pending.tsx";
import { OrganizationSettingsPending } from "./organization-settings-pending.tsx";
import { Skeleton } from "@executor-js/ui/components/skeleton";
import { AppDetailPending } from "@executor-js/ui/dashboard/app-loading";
import { parseAppSearch } from "../../contracts/navigation.ts";
import { Link, useLocation } from "@tanstack/react-router";
import { InventoryPageSkeleton, PageSkeleton } from "@executor-js/ui/dashboard/loading";

/** Lazy pages load inside the existing organization layout with the destination's content shape. */
export function PagePending({
  pathname: destination,
  organizationSettings,
}: { readonly pathname?: string; readonly organizationSettings?: ReactNode } = {}) {
  const location = useLocation();
  const pathname = destination ?? location.pathname;
  const search = location.search;
  const app = /^\/org\/([^/]+)\/apps\/app_[^/]+\/?$/.exec(pathname);
  const organizationSlug = app?.[1];
  if (organizationSlug !== undefined) {
    const selected = parseAppSearch(search);
    return (
      <AppDetailPending
        view={selected.view ?? (selected.tool === undefined ? "overview" : "tools")}
        actions={<Skeleton className="h-9 w-28 max-[740px]:h-11" />}
        selectedTool={selected.tool}
        back={
          <Link to="/org/$organizationSlug/apps" params={{ organizationSlug }}>
            Apps
          </Link>
        }
      />
    );
  }
  if (/\/apps\/?$/.test(pathname))
    return (
      <InventoryPageSkeleton
        kind="apps"
        action={<Skeleton className="h-9 w-22 rounded-md" aria-label="Loading app actions" />}
      />
    );
  if (/\/accounts\/?$/.test(pathname)) return <InventoryPageSkeleton kind="accounts" />;
  if (/\/api-keys\/?$/.test(pathname)) return <ApiKeysPending />;
  if (/\/organization\/?$/.test(pathname))
    return <OrganizationSettingsPending>{organizationSettings}</OrganizationSettingsPending>;
  const title = /\/apps\/add/.test(pathname)
    ? "Add app"
    : /\/accounts\//.test(pathname)
      ? "Account"
      : /\/apps\//.test(pathname)
        ? "App"
        : /\/connect\/?$/.test(pathname)
          ? "Connect"
          : "Executor";
  return <PageSkeleton title={title} />;
}
