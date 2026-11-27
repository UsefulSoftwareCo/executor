import { Link } from "@tanstack/react-router";
import { ApprovalsPage as SharedApprovalsPage } from "@executor-js/ui/dashboard/approvals";
import { BrowserApprovalCard } from "@executor-js/ui/dashboard/browser-approval";
import { pendingApprovalsAtom, scheduledReviewAtoms } from "../../contracts/schedules.ts";
import { Failure } from "../components/common.tsx";

export function ApprovalsPage() {
  return (
    <SharedApprovalsPage
      query={pendingApprovalsAtom}
      Failure={Failure}
      review={(item) => (
        <Link to="/approvals/$runId" params={{ runId: item.run.id }}>
          Review
        </Link>
      )}
    />
  );
}
export function ScheduledApprovalPage({ runId }: { readonly runId: string }) {
  return (
    <main className="mx-auto w-full max-w-2xl p-4 md:p-6">
      <Link to="/approvals" className="mb-4 inline-flex text-sm text-muted-foreground">
        Back to approvals
      </Link>
      <BrowserApprovalCard
        atoms={scheduledReviewAtoms(runId)}
        completion="Your response was saved. Approved runs continue in the background."
      />
    </main>
  );
}
