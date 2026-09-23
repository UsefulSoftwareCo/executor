import { createFileRoute } from "@tanstack/react-router";
import { DeleteAppPage } from "../pages/delete-app.tsx";
import { parseAppParams } from "../route-params.ts";
/** Generated-tree route for /_dashboard/_inventory/apps/$appId_/delete. */
export const Route = createFileRoute("/_dashboard/_inventory/apps/$appId_/delete")({
  staticData: { section: "apps" },
  params: { parse: parseAppParams },
  component: AppRoute,
});

function AppRoute() {
  const { appId } = Route.useParams();
  return <DeleteAppPage key={appId} id={appId} />;
}
