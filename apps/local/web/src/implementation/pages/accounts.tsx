import { Failure } from "../components/common.tsx";
import { dashboardAtoms } from "../../contracts/dashboard-bindings.ts";
import { AccountsPage as SharedPage } from "@executor-js/ui/dashboard/accounts";
import { Button } from "@executor-js/ui/components/button";
import { Link } from "@tanstack/react-router";
/** Local product supplies its own action and typed route. */
export function AccountsPage() {
  return (
    <SharedPage
      query={dashboardAtoms.inventory}
      Failure={Failure}
      action={
        <Button asChild>
          <Link to="/accounts/add">Add account</Link>
        </Button>
      }
    />
  );
}
