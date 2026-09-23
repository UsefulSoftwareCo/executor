import { createFileRoute } from "@tanstack/react-router";
import { AccountDetailPage } from "../pages/account-detail.tsx";
import { parseAccountParams } from "../route-params.ts";
/** Generated-tree route for /_dashboard/_inventory/accounts/$accountId. */
export const Route = createFileRoute("/_dashboard/_inventory/accounts/$accountId")({
  staticData: { section: "accounts" },
  params: { parse: parseAccountParams },
  component: AccountRoute,
});

function AccountRoute() {
  const { accountId } = Route.useParams();
  return <AccountDetailPage key={accountId} id={accountId} view="details" />;
}
