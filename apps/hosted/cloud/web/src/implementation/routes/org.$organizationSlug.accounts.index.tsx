import { AccountConnectionDialog } from "@executor-js/hosted-web/pages/connection-dialog";
import { parseConnectionSearch } from "@executor-js/hosted-web/contracts/navigation";
import { createFileRoute } from "@tanstack/react-router";
import { AccountsPage } from "@executor-js/hosted-web/pages/accounts";

/** Hosted account inventory. */
export const Route = createFileRoute("/org/$organizationSlug/accounts/")({
  validateSearch: parseConnectionSearch,
  component: Page,
});

function Page() {
  const { connection, client } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <>
      <AccountsPage />
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
