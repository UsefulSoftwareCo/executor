import { createFileRoute } from "@tanstack/react-router";
import { AccountDetailPage } from "@executor-js/hosted-web/pages/account-detail";

export const Route = createFileRoute("/org/$organizationSlug/accounts/$accountId_/disconnect")({
  component: Page,
});
function Page() {
  return <AccountDetailPage id={Route.useParams().accountId} view="disconnect" />;
}
