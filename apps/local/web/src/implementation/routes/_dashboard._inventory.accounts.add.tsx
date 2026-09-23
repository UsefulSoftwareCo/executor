import { createFileRoute } from "@tanstack/react-router";
import { AddAccountPage } from "../pages/add-account.tsx";
import { useOverview } from "../inventory.tsx";
import { parseAddAccountSearch } from "../../contracts/navigation.ts";
/** Generated-tree route for /_dashboard/_inventory/accounts/add. */
export const Route = createFileRoute("/_dashboard/_inventory/accounts/add")({
  staticData: { section: "accounts" },
  validateSearch: parseAddAccountSearch,
  component: AddAccountRoute,
});

function AddAccountRoute() {
  const search = Route.useSearch();
  return <AddAccountPage data={useOverview()} {...search} />;
}
