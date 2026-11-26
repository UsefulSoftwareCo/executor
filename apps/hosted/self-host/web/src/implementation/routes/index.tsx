import { createFileRoute } from "@tanstack/react-router";
import { DashboardEntryPending } from "@executor-js/hosted-web/entry";
import { OrganizationEntry } from "@executor-js/hosted-web/organization";

export const Route = createFileRoute("/")({
  component: () => <OrganizationEntry allowCreate={false} />,
  pendingComponent: () => <DashboardEntryPending />,
});
