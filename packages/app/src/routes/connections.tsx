import { createFileRoute } from "@tanstack/react-router";
import { ConnectionsPage } from "@executor-js/react/pages/connections";

export const Route = createFileRoute("/connections")({
  component: () => <ConnectionsPage />,
});
