import { Link } from "@tanstack/react-router";
import { useOrganizationRoute } from "@executor-js/hosted-web/organization";
import { Button } from "@executor-js/ui/components/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@executor-js/ui/components/card";
import type { ReactNode } from "react";

/** The billing card keeps its copy and dimensions while organization access loads. */
export function BillingSettingsPending() {
  return (
    <BillingSettingsCard>
      <Button variant="outline" disabled>
        Open billing
      </Button>
    </BillingSettingsCard>
  );
}

function BillingSettingsCard({ children }: { readonly children: ReactNode }) {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="gap-1.5 px-4 pt-4 pb-3">
        <CardTitle>
          <h2>Billing</h2>
        </CardTitle>
        <CardDescription>Manage your plan and payment details.</CardDescription>
      </CardHeader>
      <CardFooter className="px-4 pb-4">{children}</CardFooter>
    </Card>
  );
}

/** Billing navigation uses the current route and verified organization role. */
export function BillingSettings() {
  const organization = useOrganizationRoute();
  return (
    <BillingSettingsCard>
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
    </BillingSettingsCard>
  );
}
