import { createFileRoute } from "@tanstack/react-router";
import { parseAppLaunchSearch } from "@executor-js/ui/contracts/app-launch";
import { AppLaunchPage } from "@executor-js/hosted-web/pages/app-launch";
/** Account choice is local to this app launch, never a global dashboard selection. */
export const Route = createFileRoute("/org/$organizationSlug/apps/$appId_/open")({
  validateSearch: parseAppLaunchSearch,
  component: () => (
    <AppLaunchPage appId={Route.useParams().appId} returnTo={Route.useSearch().returnTo} />
  ),
});
