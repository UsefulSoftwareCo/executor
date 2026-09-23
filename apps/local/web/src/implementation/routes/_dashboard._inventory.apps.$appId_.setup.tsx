import { createFileRoute } from "@tanstack/react-router";
import { AccountSelectionPage } from "../pages/account-selection.tsx";
import { parseAppParams } from "../route-params.ts";
import { useOverview } from "../inventory.tsx";
import { parseSetupSearch } from "../../contracts/navigation.ts";
/** Generated-tree route for /_dashboard/_inventory/apps/$appId_/setup. */
export const Route = createFileRoute("/_dashboard/_inventory/apps/$appId_/setup")({
  staticData: { section: "apps" },
  params: { parse: parseAppParams },
  validateSearch: parseSetupSearch,
  component: AppRoute,
});

function AppRoute() {
  const { appId } = Route.useParams();
  const search = Route.useSearch();
  return <AccountSelectionPage key={appId} id={appId} data={useOverview()} {...search} />;
}
