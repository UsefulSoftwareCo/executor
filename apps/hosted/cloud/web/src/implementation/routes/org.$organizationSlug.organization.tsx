import { createFileRoute, Link } from "@tanstack/react-router";
import { OrganizationPage } from "@executor-js/hosted-web/pages/organization";
import { DeleteOrganization } from "../components/delete-organization.tsx";
import { useOrganizationRoute } from "@executor-js/hosted-web/organization";
import { SsoSettings } from "../components/sso-settings.tsx";
import { Button } from "@executor-js/ui/components/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@executor-js/ui/components/card";

/** Cloud adds billing settings and owner-only removal to the shared organization page. */
export const Route = createFileRoute("/org/$organizationSlug/organization")({
  component: () => (
    <OrganizationPage emailInvitations footer={<DeleteOrganization />}>
      <BillingSettings />
      <SsoSettings />
    </OrganizationPage>
  ),
});

function BillingSettings() {
  const organization = useOrganizationRoute();
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="gap-1.5 px-4 pt-4 pb-3">
        <CardTitle>
          <h2>Billing</h2>
        </CardTitle>
        <CardDescription>Manage your plan and payment details.</CardDescription>
      </CardHeader>
      <CardFooter className="px-4 pb-4">
        <Button
          asChild
          variant="outline"
          disabled={organization.role === undefined}
          disabledReason={
            organization.role === "member"
              ? "Only organization owners and admins can manage billing."
              : undefined
          }
        >
          <Link
            to="/org/$organizationSlug/billing"
            params={{ organizationSlug: organization.slug }}
            search={{ organization: "", plan: "" }}
          >
            Open billing
          </Link>
        </Button>
      </CardFooter>
    </Card>
  );
}
