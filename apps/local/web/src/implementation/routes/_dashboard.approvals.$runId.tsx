import { createFileRoute } from "@tanstack/react-router";
import { ScheduledApprovalPage } from "../pages/approvals.tsx";
export const Route = createFileRoute("/_dashboard/approvals/$runId")({
  staticData: { section: "approvals" },
  component: Review,
});
function Review() {
  const { runId } = Route.useParams();
  return <ScheduledApprovalPage runId={runId} />;
}
