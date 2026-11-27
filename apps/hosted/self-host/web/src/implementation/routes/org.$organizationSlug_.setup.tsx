import { createFileRoute, Outlet } from "@tanstack/react-router";
import { OrganizationBoundary } from "@executor-js/hosted-web/organization";
import { OrganizationSetup } from "@executor-js/hosted-web/pages/organization-setup";
import { SetupPage } from "@executor-js/hosted-web/setup-page";

export const Route = createFileRoute("/org/$organizationSlug_/setup")({
  codeSplitGroupings: [],
  component: SetupLayout,
  pendingComponent: () => <SetupPage />,
});

function SetupLayout() {
  const { organizationSlug } = Route.useParams();
  return (
    <OrganizationBoundary slug={organizationSlug}>
      <OrganizationSetup>
        <Outlet />
      </OrganizationSetup>
    </OrganizationBoundary>
  );
}
