import { createFileRoute } from "@tanstack/react-router";
import { OrganizationPage } from "@executor-js/hosted-web/pages/organization";

export const Route = createFileRoute("/org/$organizationSlug/organization")({
  component: () => <OrganizationPage />,
});
