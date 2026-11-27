import { createFileRoute } from "@tanstack/react-router";
import { ConnectionsPage } from "../pages/connections.tsx";

export const Route = createFileRoute("/_dashboard/connections")({
  staticData: { section: "connect" },
  component: ConnectionsPage,
});
