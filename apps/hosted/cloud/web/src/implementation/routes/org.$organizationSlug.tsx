import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ErrorTrackingProvider } from "@executor-js/ui/dashboard/error-tracking";
import { DashboardShell } from "@executor-js/hosted-web/shell";
import { OrganizationBoundary, OrganizationContent } from "@executor-js/hosted-web/organization";
import { HostedNavigation } from "@executor-js/hosted-web/navigation";
import { BetaNotice } from "../components/beta-notice.tsx";

/** The URL owns this tab's organization; all product pages inherit this boundary. Cloud records
 * product failures in PostHog, so its error cards can say a failure was tracked. */
export const Route = createFileRoute("/org/$organizationSlug")({ component: OrganizationLayout });
function OrganizationLayout() {
  const { organizationSlug } = Route.useParams();
  return (
    <OrganizationBoundary slug={organizationSlug}>
      <ErrorTrackingProvider>
        <DashboardShell navigation={<HostedNavigation />} banner={<BetaNotice />}>
          <OrganizationContent>
            <Outlet />
          </OrganizationContent>
        </DashboardShell>
      </ErrorTrackingProvider>
    </OrganizationBoundary>
  );
}
