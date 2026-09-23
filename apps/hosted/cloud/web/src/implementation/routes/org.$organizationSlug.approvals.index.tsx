import { createFileRoute } from "@tanstack/react-router";
import { ApprovalsPage } from "@executor-js/hosted-web/pages/approvals";
export const Route = createFileRoute("/org/$organizationSlug/approvals/")({
  component: ApprovalsPage,
});
