import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import { DashboardEntryPending } from "@executor-js/hosted-web/entry";
import { CloudPagePending } from "../components/page-pending.tsx";
import { ErrorTrackingProvider } from "@executor-js/ui/dashboard/error-tracking";
import { DashboardShell } from "@executor-js/hosted-web/shell";
import { OrganizationBoundary, OrganizationContent } from "@executor-js/hosted-web/organization";
import { NameAccountDialog } from "@executor-js/hosted-web/pages/name-account-dialog";
import { HostedNavigation } from "@executor-js/hosted-web/navigation";
import { CloudSupport } from "../components/support.tsx";
import { CloudNavigation } from "../components/navigation.tsx";

/** The URL owns this tab's organization; all product pages inherit this boundary. Cloud records
 * product failures in PostHog, so its error cards can say a failure was tracked. */
export const Route = createFileRoute("/org/$organizationSlug")({
  component: OrganizationLayout,
  // The server streams the dashboard frame and navigation first, then the organization.
  pendingComponent: OrganizationPending,
});
function OrganizationLayout() {
  const { organizationSlug } = Route.useParams();
  return (
    <OrganizationBoundary slug={organizationSlug}>
      <ErrorTrackingProvider>
        <DashboardShell
          navigation={
            <HostedNavigation>
              <CloudNavigation organizationSlug={organizationSlug} />
            </HostedNavigation>
          }
          support={<CloudSupport />}
        >
          <OrganizationContent pending={<CloudPagePending />}>
            <Outlet />
            <NameAccountDialog />
          </OrganizationContent>
        </DashboardShell>
      </ErrorTrackingProvider>
    </OrganizationBoundary>
  );
}

function OrganizationPending() {
  const { pathname } = useLocation();
  return (
    <DashboardEntryPending
      pathname={pathname}
      support={<CloudSupport />}
      navigation={<CloudNavigation pendingPage={pathname.split("/")[3] ?? "apps"} />}
    >
      <CloudPagePending />
    </DashboardEntryPending>
  );
}
