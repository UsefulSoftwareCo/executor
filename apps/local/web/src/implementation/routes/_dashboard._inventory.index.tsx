import { createFileRoute } from "@tanstack/react-router";
import { AppsPage } from "../pages/apps.tsx";
export const Route = createFileRoute("/_dashboard/_inventory/")({
  staticData: { section: "apps" },
  component: AppsRoute,
});

function AppsRoute() {
  return <AppsPage />;
}
