import { Failure } from "../components/common.tsx";
import { dashboardAtoms } from "../../contracts/dashboard-bindings.ts";
import { AppsPage as SharedPage } from "@executor-js/ui/dashboard/apps";
import { Button } from "@executor-js/ui/components/button";
import { Link } from "@tanstack/react-router";
/** Local product supplies its own action and typed route. */
export function AppsPage() {
  return (
    <SharedPage
      query={dashboardAtoms.inventory}
      Failure={Failure}
      connect={
        <Button asChild>
          <Link to="/connect">Connect an agent</Link>
        </Button>
      }
      action={
        <Button asChild>
          <Link to="/apps/add">Add app</Link>
        </Button>
      }
    />
  );
}
