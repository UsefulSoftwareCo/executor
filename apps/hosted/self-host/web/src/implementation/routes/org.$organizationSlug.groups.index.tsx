import { createFileRoute } from "@tanstack/react-router";
import { GroupsPage, groupsPageReads } from "@executor-js/hosted-web/pages/groups";

/** Group directory shared by hosted products. */
export const Route = createFileRoute("/org/$organizationSlug/groups/")({
  component: GroupsPage,
  staticData: { organizationReads: groupsPageReads },
});
