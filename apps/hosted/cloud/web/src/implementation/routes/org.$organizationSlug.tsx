import { createFileRoute, Outlet, redirect, useLocation } from "@tanstack/react-router";
import { DashboardEntryPending } from "@executor-js/hosted-web/entry";
import { CloudPagePending } from "../components/page-pending.tsx";
import { ErrorTrackingProvider } from "@executor-js/ui/dashboard/error-tracking";
import { DashboardShell } from "@executor-js/hosted-web/shell";
import { OrganizationBoundary, OrganizationContent } from "@executor-js/hosted-web/organization";
import { NameAccountDialog } from "@executor-js/hosted-web/pages/name-account-dialog";
import { HostedNavigation } from "@executor-js/hosted-web/navigation";
import { CloudSupport } from "../components/support.tsx";
import { CloudNavigation } from "../components/navigation.tsx";
import { setupGateRedirect } from "../../contracts/onboarding.ts";
import { serverDocument } from "../document.ts";

/** The URL owns this tab's organization; all product pages inherit this boundary. Cloud records
 * product failures in PostHog, so its error cards can say a failure was tracked. */
export const Route = createFileRoute("/org/$organizationSlug")({
  /**
   * A member whose setup is required stays in it until both steps are done: the server answers
   * their dashboard address with a redirect to the current step before any HTML, and the router
   * does the same before showing the dashboard when they arrive from outside it. Moving between
   * dashboard pages asks nothing.
   */
  beforeLoad: async ({ params, cause, preload }) => {
    if (preload || (!import.meta.env.SSR && cause !== "enter")) return;
    const href = await setupGateRedirect(
      import.meta.env.SSR ? serverDocument().apiFetch : (path) => fetch(path),
      params.organizationSlug,
    );
    if (href !== undefined) throw redirect({ href, replace: true });
  },
  // The page being left stays on screen while that is asked, not a dashboard that may not open.
  pendingMs: 2000,
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
