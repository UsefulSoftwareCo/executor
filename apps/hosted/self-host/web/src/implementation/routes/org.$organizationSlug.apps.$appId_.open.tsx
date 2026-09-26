import { createFileRoute } from "@tanstack/react-router";
import { parseAppLaunchSearch } from "@executor-js/ui/contracts/app-launch";
import { AppLaunchPage } from "@executor-js/hosted-web/pages/app-launch";
import { parseAppParams } from "@executor-js/hosted-web/route-params";
/** Account choice is local to this app launch, never a global dashboard selection. */
export const Route = createFileRoute("/org/$organizationSlug/apps/$appId_/open")({
  params: { parse: parseAppParams },
  validateSearch: parseAppLaunchSearch,
  component: () => (
    <AppLaunchPage appId={Route.useParams().appId} returnTo={Route.useSearch().returnTo} />
  ),
});
