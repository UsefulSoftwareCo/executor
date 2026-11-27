import { createFileRoute } from "@tanstack/react-router";
import { GroupsPage, groupsPageReads } from "@executor-js/hosted-web/pages/groups";

export const Route = createFileRoute("/org/$organizationSlug/groups/")({
  component: GroupsPage,
  staticData: { organizationReads: groupsPageReads },
});
