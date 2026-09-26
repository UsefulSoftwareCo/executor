import { createFileRoute } from "@tanstack/react-router";
import { AccountDetailPage } from "@executor-js/hosted-web/pages/account-detail";
import { parseAccountParams } from "@executor-js/hosted-web/route-params";

export const Route = createFileRoute("/org/$organizationSlug/accounts/$accountId_/disconnect")({
  params: { parse: parseAccountParams },
  component: Page,
});
function Page() {
  return <AccountDetailPage id={Route.useParams().accountId} view="disconnect" />;
}
