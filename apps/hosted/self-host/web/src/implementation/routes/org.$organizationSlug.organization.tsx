import { createFileRoute } from "@tanstack/react-router";
import { OrganizationPage } from "@executor-js/hosted-web/pages/organization";

/** Organization administration shared by both hosts. */
export const Route = createFileRoute("/org/$organizationSlug/organization")({
  component: () => <OrganizationPage />,
});
