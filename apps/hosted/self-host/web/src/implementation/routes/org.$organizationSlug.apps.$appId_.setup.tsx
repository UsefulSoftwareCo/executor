import { parseSetupSearch } from "@executor-js/hosted-web/contracts/navigation";
import { createFileRoute } from "@tanstack/react-router";
import { AccountSelectionPage } from "@executor-js/hosted-web/pages/account-selection";
export const Route = createFileRoute("/org/$organizationSlug/apps/$appId_/setup")({
  validateSearch: parseSetupSearch,
  component: () => (
    <AccountSelectionPage appId={Route.useParams().appId} profile={Route.useSearch().profile} />
  ),
});
