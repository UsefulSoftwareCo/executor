import { createFileRoute } from "@tanstack/react-router";
import { ScheduledApprovalPage } from "@executor-js/hosted-web/pages/approvals";
export const Route = createFileRoute("/org/$organizationSlug/approvals/$runId")({
  component: Review,
});
function Review() {
  const { runId } = Route.useParams();
  return <ScheduledApprovalPage runId={runId} />;
}
