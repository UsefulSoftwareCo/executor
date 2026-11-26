import { createFileRoute } from "@tanstack/react-router";
import { AccountsPage } from "../pages/accounts.tsx";
import { parseAccountsSearch } from "../../contracts/navigation.ts";
export const Route = createFileRoute("/_dashboard/_inventory/accounts/")({
  staticData: { section: "accounts" },
  validateSearch: parseAccountsSearch,
  component: AccountsRoute,
});

function AccountsRoute() {
  return <AccountsPage highlight={Route.useSearch().account} />;
}
