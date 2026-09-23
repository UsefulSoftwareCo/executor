import { createFileRoute, Outlet } from "@tanstack/react-router";
import { DashboardShell } from "@executor-js/hosted-web/shell";
import { OrganizationBoundary, OrganizationContent } from "@executor-js/hosted-web/organization";
import { HostedNavigation } from "@executor-js/hosted-web/navigation";
import { BetaNotice } from "../components/beta-notice.tsx";

/** The URL owns this tab's organization; all product pages inherit this boundary. */
export const Route = createFileRoute("/org/$organizationSlug")({ component: OrganizationLayout });
function OrganizationLayout() {
  const { organizationSlug } = Route.useParams();
  return (
    <OrganizationBoundary slug={organizationSlug}>
      <DashboardShell navigation={<HostedNavigation />} banner={<BetaNotice />}>
        <OrganizationContent>
          <Outlet />
        </OrganizationContent>
      </DashboardShell>
    </OrganizationBoundary>
  );
}
