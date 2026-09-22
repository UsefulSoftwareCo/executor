import { createFileRoute } from "@tanstack/react-router";
import { AppDetailPage } from "../pages/app-detail.tsx";
import { parseAppParams } from "../route-params.ts";
import { useOverview } from "../inventory.tsx";
import { parseAppSearch } from "../../contracts/navigation.ts";
/** Generated-tree route for /_dashboard/_inventory/apps/$appId. */
export const Route = createFileRoute("/_dashboard/_inventory/apps/$appId")({
  staticData: { section: "apps" },
  params: { parse: parseAppParams },
  validateSearch: parseAppSearch,
  component: AppRoute,
});

function AppRoute() {
  const { appId } = Route.useParams();
  const search = Route.useSearch();
  return (
    <AppDetailPage
      key={appId}
      id={appId}
      tab={search.view ?? (search.tool === undefined ? "overview" : "tools")}
      tool={search.tool}
      profile={search.profile}
      overview={useOverview()}
    />
  );
}
