import { createFileRoute } from "@tanstack/react-router";
import { AccountSelectionPage } from "../pages/account-selection.tsx";
import { parseAppParams } from "../route-params.ts";
/** Generated-tree route for /_dashboard/_inventory/apps/$appId_/setup. */
export const Route = createFileRoute("/_dashboard/_inventory/apps/$appId_/setup")({
  staticData: { section: "apps" },
  params: { parse: parseAppParams },
  component: () => (
    <AccountSelectionPage key={Route.useParams().appId} id={Route.useParams().appId} />
  ),
});
