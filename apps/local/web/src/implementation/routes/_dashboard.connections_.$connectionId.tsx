import { createFileRoute } from "@tanstack/react-router";
import { ConnectionPage } from "../pages/connections.tsx";

export const Route = createFileRoute("/_dashboard/connections_/$connectionId")({
  staticData: { section: "connect" },
  component: ConnectionRoute,
});

function ConnectionRoute() {
  const { connectionId } = Route.useParams();
  return <ConnectionPage connectionId={connectionId} />;
}
