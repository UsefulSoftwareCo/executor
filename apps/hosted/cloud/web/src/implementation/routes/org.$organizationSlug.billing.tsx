import { createFileRoute } from "@tanstack/react-router";
import { BillingPage, billingSearch } from "../pages/billing.tsx";
import { PageSkeleton } from "@executor-js/ui/dashboard/loading";

/** Cloud-only page; no matching route exists in Docker. */
export const Route = createFileRoute("/org/$organizationSlug/billing")({
  validateSearch: billingSearch,
  pendingComponent: () => <PageSkeleton title="Billing" />,
  component: () => <BillingPage returned={Route.useSearch()} />,
});
