import { createFileRoute } from "@tanstack/react-router";

import { PoliciesPage } from "../pages/policies";

export const Route = createFileRoute("/{-$orgSlug}/policies")({
  component: () => <PoliciesPage />,
});
