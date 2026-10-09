import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import { BillingPage, billingSearch } from "../pages/billing.tsx";
import { BillingPagePending } from "../components/page-pending.tsx";

/** Cloud-only page; no matching route exists in Docker. */
export const Route = createFileRoute("/org/$organizationSlug/billing")({
  validateSearch: billingSearch,
  pendingComponent: BillingPagePending,
  component: Page,
});

function Page() {
  const navigate = Route.useNavigate();
  const onCheckoutSettled = useCallback(() => {
    void navigate({
      search: ({ organization: _organization, plan: _plan, ...rest }) => rest,
      hash: true,
      replace: true,
    });
  }, [navigate]);
  return <BillingPage returned={Route.useSearch()} onCheckoutSettled={onCheckoutSettled} />;
}
