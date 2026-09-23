import { createFileRoute } from "@tanstack/react-router";
import { AppsPage } from "../pages/apps.tsx";
/** Generated-tree route for /_dashboard/_inventory/. */
export const Route = createFileRoute("/_dashboard/_inventory/")({
  staticData: { section: "apps" },
  component: AppsRoute,
});

function AppsRoute() {
  return <AppsPage />;
}
