import { createFileRoute } from "@tanstack/react-router";
import { PoliciesPage } from "@executor-js/react/pages/policies";

export const Route = createFileRoute("/$org/policies")({
  component: () => <PoliciesPage />,
});
