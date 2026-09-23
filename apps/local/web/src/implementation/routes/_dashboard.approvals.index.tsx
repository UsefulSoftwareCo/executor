import { createFileRoute } from "@tanstack/react-router";
import { ApprovalsPage } from "../pages/approvals.tsx";
export const Route = createFileRoute("/_dashboard/approvals/")({
  staticData: { section: "approvals" },
  component: ApprovalsPage,
});
