import { AccountConnectionDialog } from "@executor-js/hosted-web/pages/connection-dialog";
import { parseConnectionSearch } from "@executor-js/hosted-web/contracts/navigation";
import { createFileRoute } from "@tanstack/react-router";
import { AccountDetailPage } from "@executor-js/hosted-web/pages/account-detail";
import { parseAccountParams } from "@executor-js/hosted-web/route-params";

export const Route = createFileRoute("/org/$organizationSlug/accounts/$accountId")({
  params: { parse: parseAccountParams },
  validateSearch: parseConnectionSearch,
  component: Page,
});
function Page() {
  const { connection, client } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <>
      <AccountDetailPage id={Route.useParams().accountId} view="details" />
      <AccountConnectionDialog
        connectionId={connection}
        client={client}
        onClose={() => {
          void navigate({ search: {}, replace: true });
        }}
      />
    </>
  );
}
