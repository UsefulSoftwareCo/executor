import { createFileRoute } from "@tanstack/react-router";
import { ConnectionsPage } from "../pages/connections.tsx";

/** Generated-tree route for /_dashboard/connections. */
export const Route = createFileRoute("/_dashboard/connections")({
  staticData: { section: "connect" },
  component: ConnectionsPage,
});
