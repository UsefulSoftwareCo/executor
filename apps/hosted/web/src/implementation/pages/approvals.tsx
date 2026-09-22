import { Link } from "@tanstack/react-router";
import { ApprovalsPage as SharedApprovalsPage } from "@executor-js/ui/dashboard/approvals";
import { BrowserApprovalCard } from "@executor-js/ui/dashboard/browser-approval";
import { pendingApprovalsAtom, scheduledReviewAtoms } from "../../contracts/schedules.ts";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";
/** Pending runs are reviewed by a signed-in human through the product's normal auth boundary. */
export function ApprovalsPage() {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  return (
    <SharedApprovalsPage
      query={pendingApprovalsAtom(organization)}
      Failure={HostedFailure}
      review={(item) => (
        <Link
          to="/org/$organizationSlug/approvals/$runId"
          params={{ organizationSlug, runId: item.run.id }}
        >
          Review
        </Link>
      )}
    />
  );
}
/** Scheduled answers continue in the background; no MCP client is required. */
export function ScheduledApprovalPage({ runId }: { readonly runId: string }) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  return (
    <main className="mx-auto w-full max-w-2xl p-4 md:p-6">
      <Link
        to="/org/$organizationSlug/approvals"
        params={{ organizationSlug }}
        className="mb-4 inline-flex text-sm text-muted-foreground"
      >
        Back to approvals
      </Link>
      <BrowserApprovalCard
        atoms={scheduledReviewAtoms({ organization, run: runId })}
        completion="Your response was saved. Approved runs continue in the background."
      />
    </main>
  );
}
