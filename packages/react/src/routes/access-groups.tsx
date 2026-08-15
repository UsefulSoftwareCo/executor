import { createFileRoute } from "@tanstack/react-router";

import { AccessGroupsPage } from "../pages/access-groups";

export const Route = createFileRoute("/{-$orgSlug}/access-groups")({
  component: () => <AccessGroupsPage />,
});
