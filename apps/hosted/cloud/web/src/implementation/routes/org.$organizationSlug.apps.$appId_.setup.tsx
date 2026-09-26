import { parseSetupSearch } from "@executor-js/hosted-web/contracts/navigation";
import { createFileRoute } from "@tanstack/react-router";
import { AccountSelectionPage } from "@executor-js/hosted-web/pages/account-selection";
import { parseAppParams } from "@executor-js/hosted-web/route-params";
export const Route = createFileRoute("/org/$organizationSlug/apps/$appId_/setup")({
  params: { parse: parseAppParams },
  validateSearch: parseSetupSearch,
  component: () => (
    <AccountSelectionPage appId={Route.useParams().appId} profile={Route.useSearch().profile} />
  ),
});
