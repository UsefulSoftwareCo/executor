import { PagePending } from "@executor-js/hosted-web/page-pending";
import { BillingSettingsPending } from "./billing-settings.tsx";

/** Cloud lazy pages retain the same billing card as the organization settings page. */
export function CloudPagePending() {
  return <PagePending organizationSettings={<BillingSettingsPending />} />;
}
