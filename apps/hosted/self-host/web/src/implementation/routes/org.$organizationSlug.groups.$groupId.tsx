import { createFileRoute } from "@tanstack/react-router";
import { GroupsPage, groupsPageReads } from "@executor-js/hosted-web/pages/groups";

export const Route = createFileRoute("/org/$organizationSlug/groups/$groupId")({
  component: () => <GroupsPage id={Route.useParams().groupId} />,
  staticData: { organizationReads: groupsPageReads },
});
