import { createFileRoute, Outlet, redirect, useLocation } from "@tanstack/react-router";
import { DashboardEntryPending } from "@executor-js/hosted-web/entry";
import { CloudPagePending } from "../components/page-pending.tsx";
import { ErrorTrackingProvider } from "@executor-js/ui/dashboard/error-tracking";
import { DashboardShell } from "@executor-js/hosted-web/shell";
import { OrganizationBoundary, OrganizationContent } from "@executor-js/hosted-web/organization";
import { NameAccountDialog } from "@executor-js/hosted-web/pages/name-account-dialog";
import { HostedNavigation } from "@executor-js/hosted-web/navigation";
import { CloudSupport } from "../components/support.tsx";
import { cloudNotes, CloudWhatsNew } from "../components/whats-new.tsx";
import { CloudNavigation } from "../components/navigation.tsx";
import { setupGateRedirect } from "../../contracts/onboarding.ts";
import { serverDocument } from "../document.ts";

export const Route = createFileRoute("/org/$organizationSlug")({
  beforeLoad: async ({ params, cause, preload }) => {
    if (preload || (!import.meta.env.SSR && cause !== "enter")) return;
    const href = await setupGateRedirect(
      import.meta.env.SSR ? serverDocument().apiFetch : (path) => fetch(path),
      params.organizationSlug,
    );
    if (href !== undefined) throw redirect({ href, replace: true });
  },
  pendingMs: 2000,
  component: OrganizationLayout,
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
          news={cloudNotes.length > 0 && <CloudWhatsNew notes={cloudNotes} />}
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
