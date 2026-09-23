import { createFileRoute } from "@tanstack/react-router";
import { parseAppLaunchSearch } from "@executor-js/ui/contracts/app-launch";
import { AppLaunchPage } from "../pages/app-launch.tsx";
import { parseAppParams } from "../route-params.ts";
import { useOverview } from "../inventory.tsx";
/** Paired local launch route reuses the inventory already owned by its parent. */
export const Route = createFileRoute("/_dashboard/_inventory/apps/$appId_/open")({
  staticData: { section: "apps" },
  params: { parse: parseAppParams },
  validateSearch: parseAppLaunchSearch,
  component: () => (
    <AppLaunchPage
      id={Route.useParams().appId}
      data={useOverview()}
      returnTo={Route.useSearch().returnTo}
    />
  ),
});
