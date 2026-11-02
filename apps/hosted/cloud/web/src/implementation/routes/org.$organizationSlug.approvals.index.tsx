import { createFileRoute } from "@tanstack/react-router";
import { ApprovalsPage, approvalsPageReads } from "@executor-js/hosted-web/pages/approvals";
export const Route = createFileRoute("/org/$organizationSlug/approvals/")({
  component: ApprovalsPage,
  staticData: { organizationReads: approvalsPageReads },
});
