import { createFileRoute } from "@tanstack/react-router";
import { ConnectionPage } from "../pages/connection.tsx";

/** Generated-tree route for /_dashboard/connections_/$connectionId. */
export const Route = createFileRoute("/_dashboard/connections_/$connectionId")({
  staticData: { section: "connect" },
  component: ConnectionRoute,
});

function ConnectionRoute() {
  const { connectionId } = Route.useParams();
  return <ConnectionPage connectionId={connectionId} />;
}
