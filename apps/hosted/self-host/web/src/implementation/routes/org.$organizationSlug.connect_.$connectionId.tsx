import { createFileRoute } from "@tanstack/react-router";
import { ConnectionPage, connectionPageReads } from "@executor-js/hosted-web/pages/connect";

export const Route = createFileRoute("/org/$organizationSlug/connect_/$connectionId")({
  component: () => <ConnectionPage connectionId={Route.useParams().connectionId} />,
  staticData: { organizationReads: connectionPageReads },
});
