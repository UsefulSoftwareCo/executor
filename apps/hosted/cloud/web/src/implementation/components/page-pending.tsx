import { PagePending } from "@executor-js/hosted-web/page-pending";
import { PageSkeleton } from "@executor-js/ui/dashboard/loading";
import { useLocation } from "@tanstack/react-router";
import { BillingSettingsPending } from "./billing-settings.tsx";

export function BillingPagePending() {
  return <PageSkeleton title="Billing" />;
}

/** Cloud lazy pages retain the same billing card as the organization settings page. */
export function CloudPagePending() {
  const { pathname } = useLocation();
  if (/^\/org\/[^/]+\/billing\/?$/.test(pathname)) return <BillingPagePending />;
  return <PagePending organizationSettings={<BillingSettingsPending />} />;
}
