import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import { DashboardEntryPending } from "@executor-js/hosted-web/entry";
import { PagePending } from "@executor-js/hosted-web/page-pending";
import { DashboardShell } from "@executor-js/hosted-web/shell";
import { OrganizationBoundary, OrganizationContent } from "@executor-js/hosted-web/organization";
import { NameAccountDialog } from "@executor-js/hosted-web/pages/name-account-dialog";
import { Option } from "effect";
import type { ReactNode } from "react";
import { Navigation } from "../navigation.tsx";
import { SelfHostUpdateBlock, useSelfHostUpdate } from "../update.tsx";

/** The URL owns this tab's organization; all product pages inherit this boundary. */
export const Route = createFileRoute("/org/$organizationSlug")({
  component: OrganizationLayout,
  // The server streams the dashboard frame and navigation first, then the organization.
  pendingComponent: OrganizationPending,
});
function OrganizationLayout() {
  const { organizationSlug } = Route.useParams();
  return (
    <OrganizationBoundary slug={organizationSlug}>
      <SelfHostShell>
        <OrganizationContent pending={<PagePending />}>
          <Outlet />
          <NameAccountDialog />
        </OrganizationContent>
      </SelfHostShell>
    </OrganizationBoundary>
  );
}

/** The shell, with the update block above the links once an owner's or admin's server has one. */
function SelfHostShell({ children }: { readonly children: ReactNode }) {
  const update = useSelfHostUpdate();
  return (
    <DashboardShell
      allowCreateOrganization={false}
      navigation={<Navigation />}
      notice={Option.isSome(update) && <SelfHostUpdateBlock update={update.value} />}
    >
      {children}
    </DashboardShell>
  );
}

function OrganizationPending() {
  const { pathname } = useLocation();
  return (
    <DashboardEntryPending pathname={pathname}>
      <PagePending />
    </DashboardEntryPending>
  );
}
