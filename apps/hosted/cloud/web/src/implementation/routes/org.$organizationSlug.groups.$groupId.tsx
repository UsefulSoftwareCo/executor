import { createFileRoute } from "@tanstack/react-router";
import { GroupsPage, groupsPageReads } from "@executor-js/hosted-web/pages/groups";

/** Group membership detail stays scoped to the organization route. */
export const Route = createFileRoute("/org/$organizationSlug/groups/$groupId")({
  component: () => <GroupsPage id={Route.useParams().groupId} />,
  staticData: { organizationReads: groupsPageReads },
});
