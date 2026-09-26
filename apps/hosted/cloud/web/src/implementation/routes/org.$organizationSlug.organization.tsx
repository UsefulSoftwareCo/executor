import { createFileRoute } from "@tanstack/react-router";
import { OrganizationPage } from "@executor-js/hosted-web/pages/organization";
import { DeleteOrganization } from "../components/delete-organization.tsx";
import { SsoSettings } from "../components/sso-settings.tsx";
import { BillingSettings } from "../components/billing-settings.tsx";

/** Cloud adds billing settings and owner-only removal to the shared organization page. */
export const Route = createFileRoute("/org/$organizationSlug/organization")({
  component: () => (
    <OrganizationPage emailInvitations footer={<DeleteOrganization />}>
      <BillingSettings />
      <SsoSettings />
    </OrganizationPage>
  ),
});
