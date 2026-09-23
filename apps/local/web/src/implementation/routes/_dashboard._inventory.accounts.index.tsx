import { createFileRoute } from "@tanstack/react-router";
import { AccountsPage } from "../pages/accounts.tsx";
/** Generated-tree route for /_dashboard/_inventory/accounts/. */
export const Route = createFileRoute("/_dashboard/_inventory/accounts/")({
  staticData: { section: "accounts" },
  component: AccountsRoute,
});

function AccountsRoute() {
  return <AccountsPage />;
}
