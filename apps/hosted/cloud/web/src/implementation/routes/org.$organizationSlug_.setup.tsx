import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ErrorTrackingProvider } from "@executor-js/ui/dashboard/error-tracking";
import { OrganizationBoundary } from "@executor-js/hosted-web/organization";
import { OrganizationSetup } from "@executor-js/hosted-web/pages/organization-setup";
import { SetupPage } from "@executor-js/hosted-web/setup-page";
import { CloudSetupSequence } from "../components/team-setup.tsx";
import { setupSequenceAtom } from "../../contracts/onboarding.ts";

export const Route = createFileRoute("/org/$organizationSlug_/setup")({
  codeSplitGroupings: [],
  staticData: { organizationReads: (organization) => [setupSequenceAtom(organization)] },
  component: SetupLayout,
  pendingComponent: () => <SetupPage />,
});

function SetupLayout() {
  const { organizationSlug } = Route.useParams();
  return (
    <OrganizationBoundary slug={organizationSlug}>
      <ErrorTrackingProvider>
        <OrganizationSetup>
          <CloudSetupSequence>
            <Outlet />
          </CloudSetupSequence>
        </OrganizationSetup>
      </ErrorTrackingProvider>
    </OrganizationBoundary>
  );
}
