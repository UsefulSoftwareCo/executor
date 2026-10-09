import { createFileRoute } from "@tanstack/react-router";
import { DashboardEntryPending } from "@executor-js/hosted-web/entry";
import { OrganizationEntry } from "@executor-js/hosted-web/organization";

/** Resolve an initial destination when no usable recent-organization hint exists. */
export const Route = createFileRoute("/")({
  component: () => <OrganizationEntry allowCreate={false} />,
  // The entry's own loading view, while the server reads the memberships.
  pendingComponent: () => <DashboardEntryPending />,
});
